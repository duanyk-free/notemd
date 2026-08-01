/* ═══════════════════════════════════════════════════════════════════════
   Notemd — App core
   Tab manager, CodeMirror editor, Markdown preview, file tree, themes.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  // ── Mode map (extension → CodeMirror mode) ──────────────────────────

  const MODE_MAP = {
    md: "markdown", mdown: "markdown", markdown: "markdown",
    py: "python", pyw: "python",
    js: "javascript", mjs: "javascript", cjs: "javascript", ts: "javascript", jsx: "javascript",
    html: "xml", htm: "xml", xml: "xml", svg: "xml",
    css: "css", scss: "css", less: "css",
    sh: "shell", bash: "shell", zsh: "shell",
    c: "clike", cpp: "clike", h: "clike", hpp: "clike", java: "clike", cs: "clike",
    yaml: "yaml", yml: "yaml",
    sql: "sql",
    dockerfile: "dockerfile",
    json: "javascript", toml: "toml", ini: "properties", cfg: "properties",
    txt: null, log: null,
  };

  const MODE_LABELS = {
    markdown: "Markdown", python: "Python", javascript: "JavaScript",
    xml: "HTML/XML", css: "CSS", shell: "Shell", clike: "C/C++/Java",
    yaml: "YAML", sql: "SQL", dockerfile: "Dockerfile",
  };

  function getModeForPath(path) {
    const ext = (path || "").split(".").pop().toLowerCase();
    return MODE_MAP[ext] || null;
  }

  function getModeLabel(mode) {
    if (!mode) return "Plain Text";
    return MODE_LABELS[mode] || mode.charAt(0).toUpperCase() + mode.slice(1);
  }

  // ── Debounce helper ──────────────────────────────────────────────────

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  NotemdApp
  // ═══════════════════════════════════════════════════════════════════════

  class NotemdApp {
    constructor() {
      this.tabs = [];            // { id, title, path, content, dirty, mode }
      this.activeTabId = null;
      this.cm = null;            // CodeMirror instance
      this.cmElement = null;     // DOM element hosting CodeMirror
      this.previewVisible = false;
      this.theme = localStorage.getItem("notemd-theme") || "dark";
      this.tabCounter = 0;
      this._suppressChange = false;  // flag to skip dirty-mark during programmatic setValue
      this.init();
    }

    // ── Bootstrap ────────────────────────────────────────────────────

    init() {
      this.applyTheme();
      this.cmElement = document.getElementById("editor-pane");
      this.initEditor();
      this.bindEvents();
      this.bindKeyboard();
      this.newTab();
    }

    initEditor() {
      this.cm = CodeMirror(this.cmElement, {
        value: "",
        mode: "markdown",
        theme: this.theme === "dark" ? "material-darker" : "eclipse",
        lineNumbers: true,
        lineWrapping: true,
        foldGutter: true,
        gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter", "CodeMirror-lint-markers"],
        autoCloseBrackets: true,
        matchBrackets: true,
        styleActiveLine: true,
        tabSize: 4,
        indentUnit: 4,
        indentWithTabs: false,
        extraKeys: {
          Tab: (cm) => {
            if (cm.somethingSelected()) {
              cm.indentSelection("add");
            } else {
              cm.replaceSelection("  ", "end");
            }
          },
          "Shift-Tab": (cm) => {
            cm.indentSelection("subtract");
          },
        },
      });

      this.cm.on("changes", () => this.onEditorChange());
      this.cm.on("cursorActivity", () => this.updateStatus());
    }

    // ── Events ───────────────────────────────────────────────────────

    bindEvents() {
      // Buttons
      document.getElementById("btn-new-tab").onclick = () => this.newTab();
      document.getElementById("btn-save").onclick = () => this.saveTab();
      document.getElementById("btn-open").onclick = () => this.openFileDialog();
      document.getElementById("btn-preview").onclick = () => this.togglePreview();
      document.getElementById("btn-theme").onclick = () => this.toggleTheme();
      document.getElementById("btn-close-preview").onclick = () => this.hidePreview();

      // Tab clicks (delegation)
      document.getElementById("tabs").addEventListener("click", (e) => {
        const tab = e.target.closest(".tab");
        if (!tab) return;
        const id = tab.dataset.tabId;
        if (e.target.closest(".tab-close")) {
          this.closeTab(id);
        } else {
          this.switchTab(id);
        }
      });
    }

    bindKeyboard() {
      document.addEventListener("keydown", (e) => {
        const mod = e.ctrlKey || e.metaKey;

        if (mod && e.key === "s") {
          e.preventDefault();
          this.saveTab();
        } else if (mod && e.key === "o") {
          e.preventDefault();
          this.openFileDialog();
        } else if (mod && e.key === "n") {
          e.preventDefault();
          this.newTab();
        } else if (mod && e.key === "w") {
          e.preventDefault();
          this.closeTab(this.activeTabId);
        } else if (mod && e.shiftKey && e.key === "P") {
          e.preventDefault();
          this.togglePreview();
        } else if (mod && e.key === "f") {
          e.preventDefault();
          this.showSearch();
        } else if (e.key === "F3") {
          e.preventDefault();
          this.findNext(e.shiftKey);
        } else if (mod && e.key === "h") {
          e.preventDefault();
          this.showReplace();
      });
    }

    // ── Tab management ────────────────────────────────────────────────

    newTab(title, path, content) {
      // Save current tab state before switching
      if (this.activeTabId) this._saveCurrentToTab();

      const id = "tab-" + (++this.tabCounter);
      const ext = path ? path.split(".").pop().toLowerCase() : "";
      const mode = path ? getModeForPath(path) : "markdown";
      const tab = {
        id,
        title: title || "untitled",
        path: path || null,
        content: content || "",
        dirty: false,
        mode: mode,
      };

      this.tabs.push(tab);
      this.activeTabId = id;
      this.renderTabs();
      this._loadTabIntoEditor(tab);
      this.updateStatus();
      this.updatePreview();
      this.cm.focus();
    }

    switchTab(id) {
      if (id === this.activeTabId) return;
      this._saveCurrentToTab();

      this.activeTabId = id;
      const tab = this.tabs.find((t) => t.id === id);
      if (tab) {
        this._loadTabIntoEditor(tab);
        this.renderTabs();
        this.updateStatus();
        this.updatePreview();
        this.cm.focus();
      }
    }

    closeTab(id, force) {
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab) return;

      if (tab.dirty && !force) {
        if (confirm(`"${tab.title}" has unsaved changes.\nClose without saving?`)) {
          this._removeTab(id);
        }
      } else {
        this._removeTab(id);
      }
    }

    _removeTab(id) {
      const idx = this.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;

      this.tabs.splice(idx, 1);

      if (this.tabs.length === 0) {
        this.activeTabId = null;
        this.cm.setValue("");
        this.newTab();
        return;
      }

      if (this.activeTabId === id) {
        const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
        this.activeTabId = next.id;
        this._loadTabIntoEditor(next);
      }

      this.renderTabs();
      this.updateStatus();
      this.updatePreview();
      this.cm.focus();
    }

    _saveCurrentToTab() {
      if (!this.activeTabId) return;
      const tab = this.tabs.find((t) => t.id === this.activeTabId);
      if (!tab) return;
      tab.content = this.cm.getValue();
    }

    _loadTabIntoEditor(tab) {
      this._suppressChange = true;
      this.cm.setValue(tab.content || "");
      this._suppressChange = false;
      this.cm.clearHistory();
      this._setEditorMode(tab.path);
      this.cm.scrollTo(0, 0);
      this.renderTabs();
      document.title = (tab.dirty ? "● " : "") + tab.title + " — Notemd";

      // Auto-show preview for markdown files, hide for others
      if (tab.path && /\.(md|markdown|mdown)$/i.test(tab.path)) {
        if (!this.previewVisible) this.showPreview();
      }
    }

    _setEditorMode(path) {
      const mode = getModeForPath(path);
      if (mode) {
        this.cm.setOption("mode", mode);
      } else {
        this.cm.setOption("mode", "null");
      }
      document.getElementById("status-mode").textContent = getModeLabel(mode);
    }

    onEditorChange() {
      if (this._suppressChange) return;
      if (!this.activeTabId) return;
      const tab = this.tabs.find((t) => t.id === this.activeTabId);
      if (!tab) return;

      const content = this.cm.getValue();
      if (content !== tab.content) {
        tab.dirty = true;
        tab.content = content;
        this.renderTabs();
        this.updateStatus();
        document.title = "● " + tab.title + " — Notemd";
      }

      this.debouncedPreview();
    }

    markClean() {
      const tab = this.tabs.find((t) => t.id === this.activeTabId);
      if (tab) {
        tab.dirty = false;
        tab.content = this.cm.getValue();
        this.renderTabs();
        document.title = tab.title + " — Notemd";
      }
    }

    // ── Tabs UI ──────────────────────────────────────────────────────

    renderTabs() {
      const container = document.getElementById("tabs");
      container.innerHTML = "";
      this.tabs.forEach((tab) => {
        const el = document.createElement("div");
        el.className = "tab" + (tab.id === this.activeTabId ? " active" : "") + (tab.dirty ? " dirty" : "");
        el.dataset.tabId = tab.id;
        el.title = tab.path || tab.title;
        el.innerHTML = `
          <span class="tab-title">${this._esc(tab.title)}</span>
          <span class="tab-dirty">●</span>
          <span class="tab-close">&times;</span>
        `;
        container.appendChild(el);
      });

      // Scroll active tab into view
      const active = container.querySelector(".tab.active");
      if (active) active.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    // ── File operations ──────────────────────────────────────────────

    async saveTab() {
      const tab = this.tabs.find((t) => t.id === this.activeTabId);
      if (!tab) return;

      const content = this.cm.getValue();

      if (tab.path) {
        // Save to existing path
        try {
          const res = await fetch("/api/write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: tab.path, content }),
          });
          const data = await res.json();
          if (data.ok) {
            tab.content = content;
            this.markClean();
            this.updateStatus();
          } else {
            alert("Save failed: " + (data.error || "Unknown error"));
          }
        } catch (err) {
          alert("Save failed: " + err.message);
        }
      } else {
        // Save as — prompt for path
        this.saveTabAs();
      }
    }

    saveTabAs() {
      const path = prompt("Save as (full path):", "/home/admin/");
      if (!path) return;

      const content = this.cm.getValue();
      fetch("/api/save-as", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) {
            const tab = this.tabs.find((t) => t.id === this.activeTabId);
            if (tab) {
              tab.path = data.path;
              tab.title = data.path.split("/").pop();
              tab.content = content;
              this._setEditorMode(data.path);
              this.markClean();
              this.updateStatus();
              this.updatePreview();
            }
          } else {
            alert("Save failed: " + (data.error || "Unknown error"));
          }
        })
        .catch((err) => alert("Save failed: " + err.message));
    }

    openFileDialog() {
      this.showFilePicker();
    }

    // ── File Picker Modal ──────────────────────────────────────────────

    showFilePicker() {
      const overlay = document.getElementById("file-picker-overlay");
      overlay.classList.remove("hidden");
      document.getElementById("picker-input").value = "";
      this._pickerSelected = null;
      this._pickerDir = null;
      // Start from home directory (stored from init)
      const homeDir = this._homeDir || "/home/admin";
      this._loadPickerDir(homeDir);
      document.getElementById("picker-input").focus();

      // Close handlers
      const close = () => overlay.classList.add("hidden");
      document.getElementById("btn-picker-close").onclick = close;
      document.getElementById("btn-picker-cancel").onclick = close;
      overlay.onclick = (e) => { if (e.target === overlay) close(); };

      // Open button
      document.getElementById("btn-picker-open").onclick = () => {
        const input = document.getElementById("picker-input").value.trim();
        const target = input || this._pickerSelected;
        if (target) {
          close();
          this.loadFile(target);
        }
      };

      // Keyboard: Enter to open selected or typed path, Escape to close
      const input = document.getElementById("picker-input");
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const val = input.value.trim();
          if (val) {
            this._pickerSelected = val;
          }
          if (this._pickerSelected) {
            close();
            this.loadFile(this._pickerSelected);
          }
        } else if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      };

      // Global Escape
      const onKey = (e) => {
        if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
      };
      document.addEventListener("keydown", onKey);
    }

    async _loadPickerDir(dirPath) {
      this._pickerDir = dirPath;
      const list = document.getElementById("picker-file-list");
      const bread = document.getElementById("picker-breadcrumb");
      list.innerHTML = '<div class="picker-item"><span class="p-icon">⏳</span> Loading...</div>';

      // Breadcrumb
      const parts = dirPath.split("/").filter(Boolean);
      let cum = "";
      bread.innerHTML = '<span class="crumb" data-path="/">🏠</span>';
      parts.forEach((p, i) => {
        cum += "/" + p;
        bread.innerHTML += '<span class="crumb-sep">▸</span>';
        bread.innerHTML += `<span class="crumb" data-path="${this._esc(cum)}">${this._esc(p)}</span>`;
      });
      bread.querySelectorAll(".crumb").forEach((c) => {
        c.onclick = () => this._loadPickerDir(c.dataset.path);
      });

      try {
        const res = await fetch("/api/files?dir=" + encodeURIComponent(dirPath));
        const data = await res.json();
        if (data.error) {
          list.innerHTML = `<div class="picker-item">❌ ${this._esc(data.error)}</div>`;
          return;
        }
        list.innerHTML = "";
        data.items.forEach((item) => {
          const el = document.createElement("div");
          el.className = "picker-item";
          const icon = item.isDir ? "📁" : this._getFileIcon(item.name);
          const size = item.isDir ? "" : this._formatSize(item.size);
          el.innerHTML = `<span class="p-icon">${icon}</span><span class="p-name">${this._esc(item.name)}</span><span class="p-size">${size}</span>`;
          el.onclick = () => {
            if (item.isDir) {
              this._loadPickerDir(item.path);
            } else {
              // Select file
              list.querySelectorAll(".picker-item").forEach((e) => e.classList.remove("selected"));
              el.classList.add("selected");
              this._pickerSelected = item.path;
              document.getElementById("picker-input").value = item.path;
            }
          };
          // Double-click to open immediately
          el.ondblclick = () => {
            if (!item.isDir) {
              document.getElementById("file-picker-overlay").classList.add("hidden");
              this.loadFile(item.path);
            }
          };
          list.appendChild(el);
        });
      } catch (err) {
        list.innerHTML = `<div class="picker-item">❌ ${this._esc(err.message)}</div>`;
      }
    }

    _getFileIcon(name) {
      const ext = (name || "").split(".").pop().toLowerCase();
      const icons = { md: "📝", py: "🐍", js: "🟨", html: "🌐", css: "🎨", json: "📦", sh: "💻", yml: "⚙️", sql: "🗄", txt: "📄" };
      return icons[ext] || "📄";
    }

    _formatSize(bytes) {
      if (!bytes) return "";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / 1048576).toFixed(1) + " MB";
    }

    async loadFile(path) {
      try {
        const res = await fetch("/api/read?file=" + encodeURIComponent(path));
        const data = await res.json();
        if (data.error) {
          alert("Cannot open: " + data.error);
          return;
        }
        const title = path.split("/").pop();
        // Check if file already open
        const existing = this.tabs.find((t) => t.path === path);
        if (existing) {
          existing.content = data.content;
          existing.dirty = false;
          this.switchTab(existing.id);
          this._loadTabIntoEditor(existing);
          return;
        }
        this.newTab(title, path, data.content);
      } catch (err) {
        alert("Cannot open: " + err.message);
      }
    }

    // ── Preview ──────────────────────────────────────────────────────

    togglePreview() {
      if (this.previewVisible) {
        this.hidePreview();
      } else {
        this.showPreview();
      }
    }

    showPreview() {
      this.previewVisible = true;
      const pane = document.getElementById("preview-pane");
      pane.classList.remove("hidden");
      pane.classList.add("visible");
      document.getElementById("btn-preview").textContent = "👁 Hide Preview";
      this.updatePreview();
    }

    hidePreview() {
      this.previewVisible = false;
      const pane = document.getElementById("preview-pane");
      pane.classList.remove("visible");
      pane.classList.add("hidden");
      document.getElementById("btn-preview").textContent = "👁 Preview";
    }

    updatePreview() {
      if (!this.previewVisible) return;
      const content = this.cm.getValue();
      if (!content.trim()) {
        document.getElementById("preview-content").innerHTML = "";
        return;
      }

      // Use server-side rendering (Python markdown + Pygments)
      fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.html) {
            document.getElementById("preview-content").innerHTML = data.html;
          } else if (data.error) {
            document.getElementById("preview-content").innerHTML =
              '<p style="color:var(--danger)">Render error: ' +
              this._esc(data.error) + "</p>";
          }
        })
        .catch((err) => {
          document.getElementById("preview-content").innerHTML =
            '<p style="color:var(--danger)">Render request failed: ' +
            this._esc(err.message) + "</p>";
        });
    }

    debouncedPreview() {
      if (!this._debouncePv) {
        this._debouncePv = debounce(() => this.updatePreview(), 400);
      }
      this._debouncePv();
    }

    // ── Search ───────────────────────────────────────────────────────

    showSearch() {
      if (this.cm && typeof CodeMirror.commands.find === "function") {
        CodeMirror.commands.find(this.cm);
        // Focus the search input so Enter works immediately
        setTimeout(() => {
          const input = document.querySelector(".CodeMirror-dialog input");
          if (input) input.focus();
        }, 50);
      }
    }

    showReplace() {
      if (this.cm && typeof CodeMirror.commands.replace === "function") {
        CodeMirror.commands.replace(this.cm);
        setTimeout(() => {
          const input = document.querySelector(".CodeMirror-dialog input");
          if (input) input.focus();
        }, 50);
      }
    }

    findNext(backward) {
      if (!this.cm) return;
      if (backward) {
        if (typeof CodeMirror.commands.findPrev === "function") {
          CodeMirror.commands.findPrev(this.cm);
        }
      } else {
        if (typeof CodeMirror.commands.findNext === "function") {
          CodeMirror.commands.findNext(this.cm);
        }
      }
    }

    // ── Theme ────────────────────────────────────────────────────────

    toggleTheme() {
      this.theme = this.theme === "dark" ? "light" : "dark";
      localStorage.setItem("notemd-theme", this.theme);
      this.applyTheme();
    }

    applyTheme() {
      document.documentElement.setAttribute("data-theme", this.theme);
      document.getElementById("btn-theme").textContent =
        this.theme === "dark" ? "☀️" : "🌙";
      // Switch Pygments (code highlight) theme
      const pygmentsCSS = document.getElementById("pygments-theme");
      if (pygmentsCSS) {
        pygmentsCSS.href = this.theme === "dark"
          ? "pygments-dark.css"
          : "pygments-light.css";
      }
      // Switch CodeMirror theme
      if (this.cm) {
        this.cm.setOption("theme", this.theme === "dark" ? "material-darker" : "eclipse");
      }
    }

    // ── Sidebar ──────────────────────────────────────────────────────

  // ── Boot ───────────────────────────────────────────────────────────

    updateStatus() {
      if (!this.cm) return;
      const cursor = this.cm.getCursor();
      const tab = this.tabs.find((t) => t.id === this.activeTabId);

      document.getElementById("status-position").textContent =
        "Ln " + (cursor.line + 1) + ", Col " + (cursor.ch + 1);

      const content = this.cm.getValue();
      const words = content.trim() ? content.trim().split(/\s+/).length : 0;
      document.getElementById("status-words").textContent = words + " words";

      if (tab) {
        document.getElementById("status-file").textContent = tab.path || "untitled";
        document.getElementById("status-mode").textContent = getModeLabel(tab.mode);
      }
    }

    // ── Helpers ──────────────────────────────────────────────────────

    _esc(s) {
      const div = document.createElement("div");
      div.textContent = s;
      return div.innerHTML;
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", () => {
    window.notemd = new NotemdApp();
  });
})();
