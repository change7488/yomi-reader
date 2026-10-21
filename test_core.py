import tempfile
import unittest
import zipfile
from pathlib import Path

from core import Library, ZLibraryClient, clean_domain, parse_books


class LibraryTests(unittest.TestCase):
    def test_epub_import_metadata_and_deduplication(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.epub"
            with zipfile.ZipFile(source, "w") as book:
                book.writestr("META-INF/container.xml", '<container><rootfile full-path="content.opf"/></container>')
                book.writestr("content.opf", '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试图书</dc:title><dc:creator>测试作者</dc:creator></package>')
            library = Library(root / "library")
            self.assertTrue(library.import_file(source))
            self.assertFalse(library.import_file(source))
            item = library.local_books()[0]
            self.assertEqual((item["title"], item["author"]), ("测试图书", "测试作者"))
            self.assertTrue(Path(item["path"]).exists())
            library.remove_local(item["digest"])
            self.assertTrue(source.exists())
            self.assertFalse(library.local_books())

    def test_cloud_catalog_replacement(self):
        with tempfile.TemporaryDirectory() as folder:
            library = Library(Path(folder))
            one = {"id": "1", "hash": "abc", "title": "A", "author": "B", "format": "EPUB"}
            library.replace_cloud("saved", [one])
            library.replace_cloud("downloaded", [one])
            self.assertEqual(len(library.cloud_books()), 2)
            library.replace_cloud("saved", [])
            self.assertEqual(library.cloud_books()[0]["shelf"], "downloaded")


class ClientTests(unittest.TestCase):
    def test_domain_requires_https_and_no_path(self):
        self.assertEqual(clean_domain("https://books.example.org/"), "https://books.example.org")
        for value in ("http://books.example.org", "https://books.example.org/login", "https://user:pass@books.example.org"):
            with self.assertRaises(ValueError):
                clean_domain(value)

    def test_parse_and_session(self):
        parsed = parse_books({"books": [{"id": 4, "hash": "abc", "title": "Title", "extension": "epub"}]})
        self.assertEqual(parsed[0]["format"], "EPUB")
        client = ZLibraryClient("https://books.example.org")
        client.use_session("123", "secret")
        self.assertEqual(client.user_id, "123")
        self.assertEqual(client.session.cookies.get("remix_userkey"), "secret")


if __name__ == "__main__":
    unittest.main()

