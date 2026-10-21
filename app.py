"""BookBridge desktop UI. Run with: py -3 app.py"""

from __future__ import annotations

import json
import os
import queue
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from core import APP_DIR, Library, ZLibraryClient, clean_domain


CONFIG_FILE = APP_DIR / "settings.json"


class BookBridge(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("图书桥 · BookBridge")
        self.geometry("1100x700")
        self.minsize(820, 520)
        self.configure(bg="#141b27")
        self.library = Library()
        self.config_data = self.load_config()
        self.client: ZLibraryClient | None = None
        self.events: queue.Queue = queue.Queue()
        self.watch_previous: dict[str, tuple[int, int]] = {}
        self.watch_imported: dict[str, tuple[int, int]] = {}
        self.watch_busy = False
        self.local_rows: dict[str, dict] = {}
        self.cloud_rows: dict[str, dict] = {}
        self.search = tk.StringVar()
        self.status = tk.StringVar(value="就绪")
        self._style()
        self._build()
        self.refresh()
        self.after(200, self.process_events)
        self.after(1000, self.scan_watch)

    @staticmethod
    def load_config() -> dict:
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def save_config(self):
        APP_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(self.config_data, ensure_ascii=False, indent=2), encoding="utf-8")

    def _style(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TFrame", background="#141b27")
        style.configure("TLabel", background="#141b27", foreground="#ecf2fa", font=("Microsoft YaHei UI", 10))
        style.configure("Muted.TLabel", foreground="#9aa9bf")
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 22, "bold"))
        style.configure("TButton", font=("Microsoft YaHei UI", 10), padding=(12, 8), background="#263348", foreground="#ecf2fa", borderwidth=0)
        style.map("TButton", background=[("active", "#344963")])
        style.configure("Accent.TButton", background="#4f7ce5", foreground="white")
        style.map("Accent.TButton", background=[("active", "#6490f0")])
        style.configure("TEntry", fieldbackground="#1e2939", foreground="#ecf2fa", insertcolor="#ecf2fa", bordercolor="#3b4a60", padding=7)
        style.configure("TNotebook", background="#141b27", borderwidth=0)
        style.configure("TNotebook.Tab", background="#1d293a", foreground="#b9c6d7", padding=(22, 10), font=("Microsoft YaHei UI", 10))
        style.map("TNotebook.Tab", background=[("selected", "#344761")], foreground=[("selected", "white")])
        style.configure("Treeview", background="#1c2737", fieldbackground="#1c2737", foreground="#e7eef8", rowheight=34, borderwidth=0, font=("Microsoft YaHei UI", 10))
        style.configure("Treeview.Heading", background="#263449", foreground="#c8d5e7", relief="flat", font=("Microsoft YaHei UI", 10, "bold"))
        style.map("Treeview", background=[("selected", "#365a92")])

    def _build(self):
        header = ttk.Frame(self, padding=(24, 20, 24, 10))
        header.pack(fill="x")
        ttk.Label(header, text="图书桥", style="Title.TLabel").pack(side="left")
        ttk.Label(header, text="本地图书 · Z-Library 书架", style="Muted.TLabel").pack(side="left", padx=(16, 0), pady=(13, 0))

        toolbar = ttk.Frame(self, padding=(24, 0, 24, 14))
        toolbar.pack(fill="x")
        ttk.Button(toolbar, text="导入 EPUB / PDF", style="Accent.TButton", command=self.import_files).pack(side="left", padx=(0, 8))
        ttk.Button(toolbar, text="打开书籍", command=self.open_local).pack(side="left", padx=(0, 8))
        ttk.Button(toolbar, text="设置", command=self.open_settings).pack(side="left", padx=(0, 8))
        ttk.Button(toolbar, text="连接账号", command=self.open_login).pack(side="left", padx=(0, 8))
        ttk.Button(toolbar, text="同步书架", command=self.sync_shelves).pack(side="left", padx=(0, 8))
        ttk.Label(toolbar, text="搜索").pack(side="right", padx=(8, 0))
        ttk.Entry(toolbar, textvariable=self.search, width=23).pack(side="right")
        self.search.trace_add("write", lambda *_: self.refresh())

        self.tabs = ttk.Notebook(self)
        self.tabs.pack(fill="both", expand=True, padx=24, pady=(0, 12))
        local_tab = ttk.Frame(self.tabs, padding=8)
        cloud_tab = ttk.Frame(self.tabs, padding=8)
        self.tabs.add(local_tab, text="本地图书")
        self.tabs.add(cloud_tab, text="账号书架")

        self.local_tree = self._table(local_tab, ("title", "author", "format", "source"), ("书名", "作者", "格式", "来源"))
        self.local_tree.bind("<Double-1>", lambda _: self.open_local())
        local_bar = ttk.Frame(local_tab, padding=(0, 10, 0, 0))
        local_bar.pack(fill="x")
        ttk.Button(local_bar, text="打开选中书籍", command=self.open_local).pack(side="left", padx=(0, 8))
        ttk.Button(local_bar, text="从书库移除", command=self.remove_local).pack(side="left")
        ttk.Label(local_bar, text="导入时复制文件，原文件保留", style="Muted.TLabel").pack(side="right")

        self.cloud_tree = self._table(cloud_tab, ("title", "author", "format", "shelf"), ("书名", "作者", "格式", "书架"))
        cloud_bar = ttk.Frame(cloud_tab, padding=(0, 10, 0, 0))
        cloud_bar.pack(fill="x")
        ttk.Button(cloud_bar, text="下载选中书籍并入库", style="Accent.TButton", command=self.download_selected).pack(side="left", padx=(0, 8))
        ttk.Label(cloud_bar, text="仅手动下载选中项目；请确认你有获取权限", style="Muted.TLabel").pack(side="left")

        footer = ttk.Frame(self, padding=(24, 0, 24, 18))
        footer.pack(fill="x")
        ttk.Label(footer, textvariable=self.status, style="Muted.TLabel").pack(side="left")
        self.counts = ttk.Label(footer, style="Muted.TLabel")
        self.counts.pack(side="right")

    def _table(self, parent, columns, labels):
        holder = ttk.Frame(parent)
        holder.pack(fill="both", expand=True)
        tree = ttk.Treeview(holder, columns=columns, show="headings", selectmode="browse")
        for name, label in zip(columns, labels):
            tree.heading(name, text=label)
            tree.column(name, anchor="w", width=560 if name == "title" else 170, minwidth=90)
        tree.column("format", width=90, minwidth=70)
        scrollbar = ttk.Scrollbar(holder, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=scrollbar.set)
        tree.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        return tree

    def refresh(self):
        query = self.search.get().strip()
        self.local_rows.clear()
        self.local_tree.delete(*self.local_tree.get_children())
        for book in self.library.local_books(query):
            key = book["digest"]
            self.local_rows[key] = book
            self.local_tree.insert("", "end", iid=key, values=(book["title"], book["author"], book["format"], "下载目录" if book["source"] == "watch" else "导入/账号"))
        self.cloud_rows.clear()
        self.cloud_tree.delete(*self.cloud_tree.get_children())
        for index, book in enumerate(self.library.cloud_books(query)):
            key = str(index)
            self.cloud_rows[key] = book
            self.cloud_tree.insert("", "end", iid=key, values=(book["title"], book["author"], book["format"], "收藏" if book["shelf"] == "saved" else "下载记录"))
        self.counts.configure(text=f"本地 {len(self.local_rows)} 本  ·  云端 {len(self.cloud_rows)} 条")

    def run_task(self, label, work, completed=None):
        self.status.set(label)

        def worker():
            try:
                result = work()
                self.events.put((True, result, completed))
            except Exception as exc:
                self.events.put((False, str(exc), None))

        threading.Thread(target=worker, daemon=True).start()

    def process_events(self):
        while True:
            try:
                ok, result, completed = self.events.get_nowait()
            except queue.Empty:
                break
            if ok:
                if completed:
                    completed(result)
                self.refresh()
            else:
                self.status.set("操作失败")
                messagebox.showerror("图书桥", result)
        self.after(200, self.process_events)

    def import_files(self):
        files = filedialog.askopenfilenames(title="选择 EPUB 或 PDF", filetypes=[("电子书", "*.epub *.pdf")])
        if not files:
            return

        def work():
            return sum(self.library.import_file(Path(path)) for path in files)

        self.run_task("正在导入图书…", work, lambda count: self.status.set(f"已导入 {count} 本；重复文件已跳过"))

    def open_local(self):
        selection = self.local_tree.selection()
        if not selection:
            self.status.set("先选中一本本地图书")
            return
        path = Path(self.local_rows[selection[0]]["path"])
        if not path.exists():
            messagebox.showerror("文件不存在", "书库文件丢失，请重新导入。")
            return
        try:
            os.startfile(path)
            self.status.set(f"已打开：{self.local_rows[selection[0]]['title']}")
        except OSError as exc:
            messagebox.showerror("无法打开", f"请先安装关联的 EPUB/PDF 阅读器。\n\n{exc}")

    def remove_local(self):
        selection = self.local_tree.selection()
        if not selection:
            return
        book = self.local_rows[selection[0]]
        if messagebox.askyesno("移除图书", f"从书库移除《{book['title']}》？\n导入前的原文件不会受影响。"):
            self.library.remove_local(book["digest"])
            self.refresh()
            self.status.set("已从书库移除")

    def open_settings(self):
        dialog = tk.Toplevel(self)
        dialog.title("设置")
        dialog.geometry("600x280")
        dialog.configure(bg="#141b27")
        dialog.transient(self)
        dialog.grab_set()
        body = ttk.Frame(dialog, padding=22)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="下载监控目录").pack(anchor="w")
        watch = tk.StringVar(value=self.config_data.get("watch_dir", str(Path.home() / "Downloads")))
        line = ttk.Frame(body)
        line.pack(fill="x", pady=(6, 18))
        ttk.Entry(line, textvariable=watch).pack(side="left", fill="x", expand=True)

        def choose():
            folder = filedialog.askdirectory(parent=dialog, title="选择下载目录")
            if folder:
                watch.set(folder)

        ttk.Button(line, text="浏览", command=choose).pack(side="left", padx=(8, 0))
        ttk.Label(body, text="Z-Library HTTPS 域名（请从你信任的账号入口确认）").pack(anchor="w")
        domain = tk.StringVar(value=self.config_data.get("domain", ""))
        ttk.Entry(body, textvariable=domain).pack(fill="x", pady=(6, 8))
        ttk.Label(body, text="域名和目录会保存；账号密码及会话不会保存。", style="Muted.TLabel").pack(anchor="w")

        def save():
            try:
                normalized = clean_domain(domain.get()) if domain.get().strip() else ""
                directory = Path(watch.get()).expanduser()
                if not directory.is_dir():
                    raise ValueError("下载监控目录不存在")
                self.config_data = {"watch_dir": str(directory.resolve()), "domain": normalized}
                self.save_config()
                self.watch_previous.clear()
                self.watch_imported.clear()
                if self.client and self.client.base != normalized:
                    self.client = None
                dialog.destroy()
                self.status.set("设置已保存")
            except ValueError as exc:
                messagebox.showerror("设置无效", str(exc), parent=dialog)

        ttk.Button(body, text="保存设置", style="Accent.TButton", command=save).pack(anchor="e", pady=(18, 0))

    def open_login(self):
        domain = self.config_data.get("domain", "")
        if not domain:
            messagebox.showinfo("先设置域名", "请在“设置”里填写你确认可信的 Z-Library HTTPS 域名。")
            self.open_settings()
            return
        dialog = tk.Toplevel(self)
        dialog.title("连接 Z-Library 账号")
        dialog.geometry("550x340")
        dialog.configure(bg="#141b27")
        dialog.transient(self)
        dialog.grab_set()
        body = ttk.Frame(dialog, padding=22)
        body.pack(fill="both", expand=True)
        mode = tk.StringVar(value="password")
        ttk.Label(body, text=f"连接到：{domain}").pack(anchor="w", pady=(0, 12))
        options = ttk.Frame(body)
        options.pack(anchor="w")
        ttk.Radiobutton(options, text="账号密码", variable=mode, value="password").pack(side="left", padx=(0, 20))
        ttk.Radiobutton(options, text="已有会话", variable=mode, value="session").pack(side="left")
        ttk.Label(body, text="邮箱 / remix_userid").pack(anchor="w", pady=(15, 3))
        first = tk.StringVar()
        ttk.Entry(body, textvariable=first).pack(fill="x")
        ttk.Label(body, text="密码 / remix_userkey").pack(anchor="w", pady=(12, 3))
        second = tk.StringVar()
        ttk.Entry(body, textvariable=second, show="●").pack(fill="x")
        ttk.Label(body, text="会话仅在本次运行中保留；不会写入设置文件。", style="Muted.TLabel").pack(anchor="w", pady=(12, 0))

        def connect():
            if not first.get().strip() or not second.get():
                messagebox.showerror("信息不完整", "请输入账号和密码，或会话 ID 与密钥。", parent=dialog)
                return
            client = ZLibraryClient(domain)
            chosen_mode, a, b = mode.get(), first.get().strip(), second.get()
            second.set("")
            dialog.destroy()

            def work():
                if chosen_mode == "password":
                    client.login(a, b)
                else:
                    client.use_session(a, b)
                client.verify()
                return client

            def done(verified):
                self.client = verified
                self.status.set("账号已连接，可以同步书架")

            self.run_task("正在连接账号…", work, done)

        ttk.Button(body, text="连接", style="Accent.TButton", command=connect).pack(anchor="e", pady=(15, 0))

    def sync_shelves(self):
        if not self.client:
            messagebox.showinfo("尚未连接", "请先连接账号。")
            return

        def work():
            saved = self.client.list_shelf("saved")
            downloaded = self.client.list_shelf("downloaded")
            self.library.replace_cloud("saved", saved)
            self.library.replace_cloud("downloaded", downloaded)
            return len(saved), len(downloaded)

        self.run_task("正在同步收藏和下载记录…", work, lambda counts: self.status.set(f"同步完成：收藏 {counts[0]} 本，下载记录 {counts[1]} 本"))

    def download_selected(self):
        if not self.client:
            messagebox.showinfo("尚未连接", "请先连接账号。")
            return
        selection = self.cloud_tree.selection()
        if not selection:
            self.status.set("先选中一条账号书架记录")
            return
        book = self.cloud_rows[selection[0]]
        destination = Path(self.config_data.get("watch_dir", str(Path.home() / "Downloads")))

        def work():
            path = self.client.download(book, destination)
            added = self.library.import_file(path, "zlibrary")
            return path, added

        self.run_task("正在下载并入库…", work, lambda result: self.status.set(f"已下载并{'导入' if result[1] else '匹配已有'}：{result[0].name}"))

    def scan_watch(self):
        directory = Path(self.config_data.get("watch_dir", str(Path.home() / "Downloads")))
        if directory.is_dir() and not self.watch_busy:
            current = {}
            try:
                for path in directory.iterdir():
                    if path.suffix.lower() not in {".epub", ".pdf"} or not path.is_file():
                        continue
                    stat = path.stat()
                    current[str(path)] = (stat.st_size, stat.st_mtime_ns)
            except OSError:
                current = {}
            ready = [Path(path) for path, signature in current.items()
                     if self.watch_previous.get(path) == signature and self.watch_imported.get(path) != signature]
            self.watch_previous = current
            if ready:
                self.watch_busy = True
                for path in ready:
                    self.watch_imported[str(path)] = current[str(path)]

                def work():
                    count = 0
                    for path in ready:
                        try:
                            count += self.library.import_file(path, "watch")
                        except (OSError, ValueError):
                            self.watch_imported.pop(str(path), None)
                    return count

                def done(count):
                    self.watch_busy = False
                    if count:
                        self.status.set(f"下载目录发现 {count} 本新书，已自动入库")

                self.run_task("正在检查下载目录…", work, done)
        self.after(8000, self.scan_watch)


if __name__ == "__main__":
    BookBridge().mainloop()

