"""Tests for document text extraction (_extract_text in documents.py)."""

import sys
from unittest.mock import MagicMock, patch

from app.api.endpoints.documents import _extract_text

DOCX_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


class TestExtractTextPlain:
    """Tests for plain text extraction."""

    def test_decodes_utf8_bytes(self):
        """Should decode UTF-8 bytes to string."""
        raw = "Hello world".encode("utf-8")
        result = _extract_text(raw, "text/plain")
        assert result == "Hello world"

    def test_handles_non_utf8_with_replace(self):
        """Should replace invalid UTF-8 bytes instead of raising."""
        raw = b"\xff\xfe Invalid bytes"
        result = _extract_text(raw, "text/plain")
        assert "Invalid bytes" in result


class TestExtractTextPDF:
    """Tests for PDF text extraction."""

    def test_extracts_text_from_pdf(self):
        """Should extract text from all pages of a PDF."""
        mock_reader = MagicMock()
        page1 = MagicMock()
        page1.extract_text.return_value = "Page 1 content"
        page2 = MagicMock()
        page2.extract_text.return_value = "Page 2 content"
        mock_reader.pages = [page1, page2]

        mock_pypdf2 = MagicMock()
        mock_pypdf2.PdfReader.return_value = mock_reader

        # The function does `from PyPDF2 import PdfReader` each call,
        # so placing a mock in sys.modules makes it pick up our mock.
        saved = sys.modules.get("PyPDF2")
        sys.modules["PyPDF2"] = mock_pypdf2
        try:
            result = _extract_text(b"fake pdf", "application/pdf")
        finally:
            if saved is not None:
                sys.modules["PyPDF2"] = saved
            else:
                sys.modules.pop("PyPDF2", None)

        assert "Page 1 content" in result
        assert "Page 2 content" in result

    def test_handles_page_with_no_text(self):
        """Should handle pages that return None for extract_text."""
        mock_reader = MagicMock()
        page = MagicMock()
        page.extract_text.return_value = None
        mock_reader.pages = [page]

        mock_pypdf2 = MagicMock()
        mock_pypdf2.PdfReader.return_value = mock_reader

        saved = sys.modules.get("PyPDF2")
        sys.modules["PyPDF2"] = mock_pypdf2
        try:
            result = _extract_text(b"fake pdf", "application/pdf")
        finally:
            if saved is not None:
                sys.modules["PyPDF2"] = saved
            else:
                sys.modules.pop("PyPDF2", None)

        # `None or ""` => ""
        assert result == ""

    def test_falls_back_when_pypdf2_not_installed(self):
        """Should fall back to raw decode when PyPDF2 is not available."""
        saved = sys.modules.get("PyPDF2")
        # Setting to None causes `import PyPDF2` to raise ImportError
        sys.modules["PyPDF2"] = None  # type: ignore[assignment]
        try:
            result = _extract_text(b"raw pdf-like content", "application/pdf")
            assert "raw pdf-like content" in result
        finally:
            if saved is not None:
                sys.modules["PyPDF2"] = saved
            else:
                sys.modules.pop("PyPDF2", None)


class TestExtractTextDocx:
    """Tests for DOCX text extraction."""

    def test_extracts_text_from_docx(self):
        """Should extract text from all paragraphs of a DOCX."""
        para1 = MagicMock()
        para1.text = "Paragraph 1"
        para2 = MagicMock()
        para2.text = "Paragraph 2"

        mock_doc = MagicMock()
        mock_doc.paragraphs = [para1, para2]

        mock_docx_module = MagicMock()
        mock_docx_module.Document.return_value = mock_doc

        saved = sys.modules.get("docx")
        sys.modules["docx"] = mock_docx_module
        try:
            result = _extract_text(b"fake docx", DOCX_CONTENT_TYPE)
        finally:
            if saved is not None:
                sys.modules["docx"] = saved
            else:
                sys.modules.pop("docx", None)

        assert "Paragraph 1" in result
        assert "Paragraph 2" in result

    def test_falls_back_when_docx_not_installed(self):
        """Should fall back to raw decode when python-docx is not available."""
        saved = sys.modules.get("docx")
        sys.modules["docx"] = None  # type: ignore[assignment]
        try:
            result = _extract_text(b"raw docx-like content", DOCX_CONTENT_TYPE)
            assert "raw docx-like content" in result
        finally:
            if saved is not None:
                sys.modules["docx"] = saved
            else:
                sys.modules.pop("docx", None)


class TestExtractTextUnknown:
    """Tests for unknown content types."""

    def test_unknown_type_falls_back_to_decode(self):
        """Should decode raw bytes for unrecognized content types."""
        raw = b"some binary data"
        result = _extract_text(raw, "application/octet-stream")
        assert result == "some binary data"
