"""Local library and optional Z-Library EAPI connection."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
import time
import zipfile
from contextlib import closing
from pathlib import Path
from urllib.parse import urljoin, urlparse
from xml.etree import ElementTree

import requests


APP_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "BookBridge"
SUPPORTED = {".epub", ".pdf"}


def clean_domain(value: str) -> str:
    url = urlparse(value.strip())
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
        raise ValueError("请输入完整的 HTTPS 域名，例如 https://你的个人域名")
    return f"https://{url.netloc}".rstrip("/")


def read_metadata(path: Path) -> tuple[str, str]:
    title, author = path.stem, ""
    try:
        if path.suffix.lower() == ".epub":
            with zipfile.ZipFile(path) as book:
                container = ElementTree.fromstring(book.read("META-INF/container.xml"))
                opf = next(x.attrib["full-path"] for x in container.iter() if x.tag.endswith("rootfile"))
                package = ElementTree.fromstring(book.read(opf))
                for element in package.iter():
                    if element.tag.endswith("}title") and element.text:
                        title = element.text.strip()
                    elif element.tag.endswith("}creator") and element.text:
                        author = element.text.strip()
        elif path.suffix.lower() == ".pdf":
            try:
                import fitz

                with fitz.open(path) as pdf:
                    meta = pdf.metadata or {}
                    title = (meta.get("title") or title).strip()
                    author = (meta.get("author") or author).strip()
            except ImportError:
                pass
    except (KeyError, OSError, ValueError, zipfile.BadZipFile, ElementTree.ParseError):
        pass
    return title or path.stem, author


def valid_book_file(path: Path) -> bool:
    if path.suffix.lower() not in SUPPORTED or not path.is_file():
        return False
    try:
        with path.open("rb") as file:
            signature = file.read(5)
        return signature.startswith(b"%PDF-") if path.suffix.lower() == ".pdf" else signature.startswith(b"PK")
    except OSError:
        return False


class Library:
    def __init__(self, root: Path = APP_DIR):
        self.root = root
        self.files = root / "books"
        self.root.mkdir(parents=True, exist_ok=True)
        self.files.mkdir(exist_ok=True)
        self.db = root / "library.sqlite3"
        with closing(self.connect()) as conn, conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS books (
                    digest TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL,
                    format TEXT NOT NULL, path TEXT NOT NULL, added_at INTEGER NOT NULL,
                    source TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS cloud_books (
                    book_id TEXT NOT NULL, book_hash TEXT NOT NULL,
                    title TEXT NOT NULL, author TEXT NOT NULL, format TEXT NOT NULL,
                    shelf TEXT NOT NULL, synced_at INTEGER NOT NULL,
                    PRIMARY KEY (book_id, book_hash, shelf)
                );
            """)

    def connect(self):
        conn = sqlite3.connect(self.db, timeout=15)
        conn.row_factory = sqlite3.Row
        return conn

    def import_file(self, source: Path, origin: str = "manual") -> bool:
        source = source.resolve()
        if not valid_book_file(source):
            raise ValueError(f"不是有效的 EPUB/PDF 文件：{source.name}")
        digest = hashlib.sha256()
        with source.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        key = digest.hexdigest()
        with closing(self.connect()) as conn, conn:
            if conn.execute("SELECT 1 FROM books WHERE digest=?", (key,)).fetchone():
                return False
        target = self.files / f"{key}{source.suffix.lower()}"
        if source != target:
            with tempfile.NamedTemporaryFile(dir=self.files, delete=False) as temporary:
                temp = Path(temporary.name)
            try:
                shutil.copyfile(source, temp)
                temp.replace(target)
            finally:
                temp.unlink(missing_ok=True)
        title, author = read_metadata(source)
        with closing(self.connect()) as conn, conn:
            conn.execute(
                "INSERT OR IGNORE INTO books VALUES (?,?,?,?,?,?,?)",
                (key, title, author, source.suffix[1:].upper(), str(target), int(time.time()), origin),
            )
        return True

    def local_books(self, search: str = ""):
        with closing(self.connect()) as conn, conn:
            return [dict(row) for row in conn.execute(
                "SELECT * FROM books WHERE title LIKE ? OR author LIKE ? ORDER BY added_at DESC, title",
                (f"%{search}%", f"%{search}%"),
            )]

    def cloud_books(self, search: str = ""):
        with closing(self.connect()) as conn, conn:
            return [dict(row) for row in conn.execute(
                "SELECT * FROM cloud_books WHERE title LIKE ? OR author LIKE ? ORDER BY shelf, title",
                (f"%{search}%", f"%{search}%"),
            )]

    def replace_cloud(self, shelf: str, books: list[dict]) -> None:
        now = int(time.time())
        with closing(self.connect()) as conn, conn:
            conn.execute("DELETE FROM cloud_books WHERE shelf=?", (shelf,))
            conn.executemany(
                "INSERT OR REPLACE INTO cloud_books VALUES (?,?,?,?,?,?,?)",
                [(b["id"], b["hash"], b["title"], b["author"], b["format"], shelf, now) for b in books],
            )

    def remove_local(self, digest: str) -> None:
        with closing(self.connect()) as conn, conn:
            row = conn.execute("SELECT path FROM books WHERE digest=?", (digest,)).fetchone()
            if row:
                conn.execute("DELETE FROM books WHERE digest=?", (digest,))
        if row:
            Path(row["path"]).unlink(missing_ok=True)


def parse_books(payload: dict) -> list[dict]:
    raw = payload.get("books")
    if raw is None and isinstance(payload.get("response"), dict):
        raw = payload["response"].get("books")
    if not isinstance(raw, list):
        raise ValueError("服务器响应中没有图书列表；接口可能已变化")
    result = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        book_id = str(item.get("id") or "").strip()
        book_hash = str(item.get("hash") or "").strip()
        if book_id and book_hash:
            result.append({
                "id": book_id, "hash": book_hash,
                "title": str(item.get("title") or "未命名图书").strip(),
                "author": str(item.get("author") or "").strip(),
                "format": str(item.get("extension") or "").upper().strip(),
            })
    return result


class ZLibraryClient:
    def __init__(self, domain: str):
        self.base = clean_domain(domain)
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "BookBridge/0.1", "Accept": "application/json"})
        self.user_id = ""
        self.user_key = ""

    def _request(self, method: str, path: str, **kwargs) -> dict:
        headers = kwargs.pop("headers", {})
        if self.user_id and self.user_key:
            headers.update({"remix-userid": self.user_id, "remix-userkey": self.user_key})
        response = self.session.request(method, self.base + path, headers=headers, timeout=20, allow_redirects=False, **kwargs)
        if response.is_redirect:
            raise RuntimeError("服务端跳转或访问受限；请检查域名是否为你确认的个人域名")
        try:
            payload = response.json()
        except ValueError as exc:
            response.raise_for_status()
            raise RuntimeError("服务端未返回 JSON；可能有登录墙或接口变更") from exc
        if not isinstance(payload, dict):
            raise RuntimeError("服务端返回了未知格式")
        if payload.get("success") in (0, False):
            raise RuntimeError(str(payload.get("error") or payload.get("message") or "服务端拒绝请求"))
        response.raise_for_status()
        return payload

    def login(self, email: str, password: str) -> None:
        payload = self._request("POST", "/eapi/user/login", data={"email": email, "password": password}, headers={"X-Requested-With": "XMLHttpRequest"})
        user = payload.get("user") or payload.get("response") or {}
        if not isinstance(user, dict):
            raise RuntimeError("登录响应格式无法识别")
        self.use_session(str(user.get("id") or user.get("user_id") or ""), str(user.get("remix_userkey") or user.get("user_key") or ""))

    def use_session(self, user_id: str, user_key: str) -> None:
        if not user_id.strip() or not user_key.strip():
            raise ValueError("会话 ID 和密钥都不能为空")
        self.user_id, self.user_key = user_id.strip(), user_key.strip()
        self.session.cookies.set("remix_userid", self.user_id, domain=urlparse(self.base).hostname)
        self.session.cookies.set("remix_userkey", self.user_key, domain=urlparse(self.base).hostname)

    def verify(self) -> None:
        self._request("GET", "/eapi/user/profile")

    def list_shelf(self, shelf: str, max_pages: int = 20) -> list[dict]:
        if shelf not in {"saved", "downloaded"}:
            raise ValueError("未知书架")
        books, seen = [], set()
        for page in range(1, max_pages + 1):
            payload = self._request("GET", f"/eapi/user/book/{shelf}", params={"page": page, "limit": 100})
            batch = parse_books(payload)
            if not batch:
                break
            for book in batch:
                key = (book["id"], book["hash"])
                if key not in seen:
                    books.append(book)
                    seen.add(key)
            if len(batch) < 100:
                break
        return books

    def download(self, book: dict, destination: Path) -> Path:
        book_id, book_hash = book["book_id"], book["book_hash"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", book_id) or not re.fullmatch(r"[A-Za-z0-9_-]+", book_hash):
            raise ValueError("图书 ID 格式无效")
        payload = self._request("GET", f"/eapi/book/{book_id}/{book_hash}/file")
        file_info = payload.get("file") or {}
        if not isinstance(file_info, dict):
            raise RuntimeError("服务端未提供下载信息")
        link = file_info.get("downloadLink") or file_info.get("download_link")
        parsed = urlparse(str(link or ""))
        if parsed.scheme != "https" or not parsed.hostname:
            raise RuntimeError("服务端未提供有效的 HTTPS 下载链接")
        ext = str(file_info.get("extension") or book["format"]).lower().lstrip(".")
        if ext not in {"epub", "pdf"}:
            raise RuntimeError("目前只支持下载 EPUB/PDF")
        destination.mkdir(parents=True, exist_ok=True)
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", book["title"]).strip(" .")[:100] or book_id
        target = destination / f"{name}-{book_id}.{ext}"
        if target.exists() and valid_book_file(target):
            return target
        # Do not send account headers or cookies to a different download host.
        same_host = parsed.hostname == urlparse(self.base).hostname
        downloader = self.session if same_host else requests.Session()
        for _ in range(5):
            response = downloader.get(link, stream=True, timeout=60, allow_redirects=False)
            if not response.is_redirect:
                break
            new_link = urljoin(link, response.headers.get("Location", ""))
            response.close()
            if urlparse(new_link).scheme != "https":
                raise RuntimeError("下载地址跳转到了非 HTTPS 链接，已停止")
            link = new_link
            if urlparse(link).hostname != urlparse(self.base).hostname:
                downloader = requests.Session()
        else:
            raise RuntimeError("下载地址跳转次数过多")
        temp = None
        try:
            with response:
                response.raise_for_status()
                with tempfile.NamedTemporaryFile(dir=destination, delete=False) as output:
                    temp = Path(output.name)
                    for chunk in response.iter_content(1024 * 1024):
                        if chunk:
                            output.write(chunk)
        except Exception:
            if temp:
                temp.unlink(missing_ok=True)
            raise
        if not valid_book_file_as(temp, ext):
            temp.unlink(missing_ok=True)
            raise RuntimeError("下载内容不是有效的 EPUB/PDF")
        temp.replace(target)
        return target


def valid_book_file_as(path: Path, ext: str) -> bool:
    with path.open("rb") as file:
        signature = file.read(5)
    return signature.startswith(b"%PDF-") if ext == "pdf" else signature.startswith(b"PK")

