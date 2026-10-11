"""Local PDF normalization and actual high-DPI region reslicing.

Repository FC entrypoint is not available. A reviewed optional adapter implements
normalize_invoice(path, regions) and is explicitly hash pinned. No guessed cloud
handler is invoked; no arbitrary external OCR request is permitted.
"""
from __future__ import annotations
import hashlib
import importlib.util
import json
import math
import os
import threading
import unicodedata
from pathlib import Path
from tools.reconciliation_tool import EvidenceError


def _clean(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text) if not unicodedata.category(c).startswith("C") or c in "\n\t")


# PDFium has process-global native state and must not be used concurrently,
# even for different documents. Keep initial text extraction parallel; serialize
# repair calls until every document/page/bitmap has been closed.
_PDFIUM_LOCK = threading.RLock()


def run_ocr_normalizer(file_path: str, regions: list | None = None, cycle: int = 0) -> dict:
    if cycle:
        with _PDFIUM_LOCK:
            return _normalize_pdf(file_path, regions, cycle)
    return _normalize_pdf(file_path, regions, cycle)


def _normalize_pdf(file_path: str, regions: list | None = None, cycle: int = 0) -> dict:
    import pdfplumber
    import pypdfium2 as pdfium
    from PIL import ImageEnhance, ImageOps
    path = Path(file_path).resolve()
    if path.suffix.lower() != ".pdf" or not path.is_file():
        raise EvidenceError("OCR input must be an ingested PDF")
    pages, crops = [], []
    with pdfplumber.open(path) as pdf:
        if not 1 <= len(pdf.pages) <= 100:
            raise EvidenceError("PDF requires 1..100 pages")
        for index, page in enumerate(pdf.pages):
            words = page.extract_words()
            text = _clean(page.extract_text() or "")
            if len(words) > 20000:
                raise EvidenceError("PDF word count exceeds extraction limits")
            pages.append({"page": index + 1, "width": page.width, "height": page.height,
                          "text": text, "words": [{"text": _clean(w["text"]), "bbox": [w["x0"], w["top"], w["x1"], w["bottom"]]} for w in words],
                          "tables": [{"bbox": list(t.bbox), "rows": t.extract()} for t in page.find_tables()]})
    if cycle:
        if not 1 <= cycle <= 3:
            raise EvidenceError("Self-heal cycle must be 1..3")
        folder = path.parent.parent / "crops" / f"cycle-{cycle}"
        folder.mkdir(parents=True, exist_ok=True)
        document = pdfium.PdfDocument(str(path))
        try:
            targets = regions or [{"page": p["page"], "bbox": [0, 0, p["width"], p["height"]]} for p in pages]
            if len(targets) > 100:
                raise EvidenceError("Too many localized OCR regions")
            for index, region in enumerate(targets):
                page_index = int(region["page"]) - 1
                if not 0 <= page_index < len(document):
                    raise EvidenceError("Invalid OCR page index")
                dpi = 240 + cycle * 40
                scale = dpi / 72
                page = document[page_index]
                bitmap = image = None
                try:
                    width, height = page.get_size()
                    x0, y0, x1, y1 = [float(v) for v in region["bbox"]]
                    source_width, source_height = pages[page_index]["width"], pages[page_index]["height"]
                    if (not all(math.isfinite(v) for v in (x0, y0, x1, y1))
                            or not 0 <= x0 < x1 <= source_width
                            or not 0 <= y0 < y1 <= source_height):
                        raise EvidenceError("OCR bounding box outside page")
                    # Map pdfplumber coordinates to PDFium's float32 page domain.
                    x0, x1 = x0 * width / source_width, x1 * width / source_width
                    y0, y1 = y0 * height / source_height, y1 * height / source_height
                    if width * height * scale * scale > 25000000:
                        raise EvidenceError("OCR rendering exceeds pixel budget")
                    bitmap = page.render(scale=scale)
                    image = bitmap.to_pil().crop((int(x0*scale), int(y0*scale), int(x1*scale), int(y1*scale)))
                    image = ImageEnhance.Contrast(ImageOps.grayscale(image)).enhance(1.2 + cycle * 0.3)
                    crop = folder / f"{path.stem}-{page_index+1}-{index}.png"
                    image.save(crop)
                    crop_text = None
                    # Optional local Tesseract; never claim vision OCR without engine.
                    import shutil
                    if shutil.which("tesseract"):
                        import pytesseract
                        crop_text = _clean(pytesseract.image_to_string(image, config="--psm 6", timeout=30))
                    crops.append({"page": page_index+1, "bbox": region["bbox"], "dpi": dpi,
                                  "sha256": hashlib.sha256(crop.read_bytes()).hexdigest(), "text": crop_text,
                                  "local_crop": str(crop), "vision_ocr_available": crop_text is not None})
                finally:
                    # Native handles must also close on save/OCR failures while
                    # the process-global PDFium lock is still held.
                    try:
                        if image is not None:
                            image.close()
                    finally:
                        try:
                            if bitmap is not None:
                                bitmap.close()
                        finally:
                            page.close()
        finally:
            document.close()
    result = {"source": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
              "pages": pages, "crops": crops, "cycle": cycle,
              "scanned": not any(p["text"].strip() for p in pages), "backend": "local_pdfplumber_pdfium"}
    adapter_path = os.environ.get("OUT_IN_OCR_ADAPTER")
    if adapter_path:
        adapter = Path(adapter_path).resolve()
        expected = os.environ.get("OUT_IN_OCR_ADAPTER_SHA256")
        if not adapter.is_file() or not expected or hashlib.sha256(adapter.read_bytes()).hexdigest() != expected:
            raise EvidenceError("FC OCR adapter must be operator reviewed and hash pinned")
        spec = importlib.util.spec_from_file_location("reviewed_fc_normalizer", adapter)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if not callable(getattr(module, "normalize_invoice", None)):
            raise EvidenceError("Reviewed FC bridge must implement normalize_invoice(path,regions)")
        result["reviewed_fc_result"] = module.normalize_invoice(str(path), regions or [])
        result["adapter_sha256"] = expected
    return result


def parse_demo_packet(normalized: dict) -> dict:
    """Only our explicit synthetic demo format; never impersonates LLM extraction."""
    text = "\n".join(p["text"] for p in normalized["pages"])
    start, end = text.find("OUT_IN_DEMO_JSON_BEGIN"), text.find("OUT_IN_DEMO_JSON_END")
    if start < 0 or end <= start:
        raise EvidenceError("Demo mode accepts only clearly marked generated demo PDFs; use SDK mode for real dossiers")
    payload = json.loads(text[start + len("OUT_IN_DEMO_JSON_BEGIN"):end].strip())
    if payload.get("is_demo") is not True or payload.get("kind") not in ("invoice", "delivery"):
        raise EvidenceError("Invalid synthetic demo packet")
    record = payload["data"]
    record["source"] = normalized["source"]
    record["regions"] = [{"page": p["page"], "bbox": [0,0,p["width"],p["height"]]} for p in normalized["pages"]]
    return {"kind": payload["kind"], "data": record}
