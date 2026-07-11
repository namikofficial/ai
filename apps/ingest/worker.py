# Python document ingestion worker for the AI Workbench.
#
# Bounded, single-file worker invoked by the TypeScript runtime via subprocess.
# Outputs JSON on stdout. Never writes to SQLite directly — the TS side reads
# stdout and writes chunks into SQLite FTS5 + Qdrant.
#
# Usage:
#   python3 -m apps.ingest.worker crawl <url> [--output-dir <dir>]
#   python3 -m apps.ingest.worker parse <path> [--output-dir <dir>]
#
# Crawl4AI for web docs; Docling for PDF/DOCX/PPTX; MinerU for formula PDFs.
# All outputs are Markdown chunks with metadata.

import argparse
import json
import sys
from pathlib import Path

try:
    from crawl4ai import WebCrawler
except ImportError:
    WebCrawler = None

try:
    from docling.document_converter import DocumentConverter
except ImportError:
    DocumentConverter = None


def crawl(url: str, output_dir: Path) -> list[dict]:
    """Crawl a URL with Crawl4AI and return markdown chunks."""
    if WebCrawler is None:
        return [{"error": "crawl4ai not installed. Run: pip install crawl4ai"}]

    crawler = WebCrawler()
    result = crawler.run(url=url)
    chunks = []
    if hasattr(result, "markdown"):
        lines = result.markdown.split("\n")
        for i in range(0, len(lines), 50):
            chunk_text = "\n".join(lines[i : i + 50])
            chunks.append(
                {
                    "source": url,
                    "kind": "web_doc",
                    "content": chunk_text,
                    "start_line": i + 1,
                    "end_line": min(i + 50, len(lines)),
                    "path": f"web/{url.replace('://', '/').rstrip('/')}.md",
                }
            )
    return chunks


def parse_doc(path: str, output_dir: Path, engine: str = "docling") -> list[dict]:
    """Parse a document file with Docling or MinerU and return markdown chunks."""
    source = Path(path)
    ext = source.suffix.lower()

    if engine == "mineru":
        return [{"error": "MinerU not yet wired; install python-mineru and use --engine mineru"}]

    if DocumentConverter is None:
        return [{"error": "docling not installed. Run: pip install docling"}]

    converter = DocumentConverter()
    result = converter.convert(str(source))
    md_text = result.document.export_to_markdown()
    lines = md_text.split("\n")
    chunks = []
    for i in range(0, len(lines), 50):
        chunk_text = "\n".join(lines[i : i + 50])
        chunks.append(
            {
                "source": str(source),
                "kind": "document",
                "content": chunk_text,
                "start_line": i + 1,
                "end_line": min(i + 50, len(lines)),
                "path": f"docs/{source.stem}/page.md",
            }
        )
    return chunks


def main() -> None:
    parser = argparse.ArgumentParser(description="AI Workbench document ingestion worker")
    sub = parser.add_subparsers(dest="command", required=True)

    crawl_p = sub.add_parser("crawl", help="Crawl a URL")
    crawl_p.add_argument("url", help="The URL to crawl")
    crawl_p.add_argument("--output-dir", default="knowledge/web")

    parse_p = sub.add_parser("parse", help="Parse a document")
    parse_p.add_argument("path", help="Path to the document")
    parse_p.add_argument("--engine", choices=["docling", "mineru"], default="docling")
    parse_p.add_argument("--output-dir", default="knowledge/docs")

    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.command == "crawl":
        results = crawl(args.url, output_dir)
    elif args.command == "parse":
        results = parse_doc(args.path, output_dir, engine=args.engine)
    else:
        results = [{"error": f"unknown command: {args.command}"}]

    json.dump(results, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
