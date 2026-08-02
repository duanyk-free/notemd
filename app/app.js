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
      try {
        this.applyTheme();
        this.cmElement = document.getElementById("editor-pane");
        this.initEditor();
        this.bindEvents();
        this.bindKeyboard();
        this.newTab();
        // Signal successful init
        document.getElementById("status-file").textContent = "Ready";
        document.getElementById("status-mode").textContent = "Notemd v0.2";
      } catch (e) {
        document.body.innerHTML = '<div style="padding:40px;color:red;font-family:monospace"><h2>Init Error</h2><pre>' + e.message + '\n\n' + e.stack + '</pre></div>';
        throw e;
      }
    }

    initEditor() {
      try {
        this.cm = CodeMirror(this.cmElement, {
        value: "",
        mode: "markdown",
        theme: this.theme === "dark" ? "material-darker" : "eclipse",
        lineNumbers: true,
        lineWrapping: true,
        foldGutter: true,
        gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
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
      } catch (e) {
        // CodeMirror failed to initialize — show error but continue
        document.getElementById("editor-pane").innerHTML =
          '<div style="padding:20px;color:var(--danger)">' +
          'Editor failed to load: ' + e.message + '</div>';
        this.cm = null;
      }
    }

    // ── Events ───────────────────────────────────────────────────────

    bindEvents() {
      // Buttons
      document.getElementById("btn-new-tab").onclick = () => this.newTab();
      document.getElementById("btn-save").onclick = () => this.saveTab();
      document.getElementById("btn-open").onclick = () => this.openFileDialog();
      document.getElementById("btn-preview").onclick = () => this.togglePreview();
      document.getElementById("btn-md-help").onclick = () => this.showMdHelp();
      document.getElementById("btn-md-help-close").onclick = () => {
        document.getElementById("md-help-overlay").classList.add("hidden");
      };
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
      var self = this;
      document.addEventListener("keydown", function (e) {
        var mod = e.ctrlKey || e.metaKey;
        if (mod && e.key === "s") { e.preventDefault(); self.saveTab(); }
        else if (mod && e.key === "o") { e.preventDefault(); self.openFileDialog(); }
        else if (mod && e.key === "n") { e.preventDefault(); self.newTab(); }
        else if (mod && e.key === "w") { e.preventDefault(); self.closeTab(self.activeTabId); }
        else if (mod && e.shiftKey && e.key === "P") { e.preventDefault(); self.togglePreview(); }
        else if (mod && e.key === "f") { e.preventDefault(); self.showSearch(); }
        else if (e.key === "F3") { e.preventDefault(); self.findNext(e.shiftKey); }
        else if (mod && e.key === "h") { e.preventDefault(); self.showReplace(); }
        else if (mod && e.shiftKey && e.key === "H") { e.preventDefault(); self.showMdHelp(); }
      });
    }

    // ── Tab management ────────────────────────────────────────────────

    newTab(title, path, content) {
      if (!this.cm) return;  // Editor not initialized
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

      // Auto-show preview & help button for markdown files
      var isMd = tab.path && /\.(md|markdown|mdown)$/i.test(tab.path);
      document.getElementById("btn-md-help").style.display = isMd ? "" : "none";
      if (isMd && !this.previewVisible) this.showPreview();
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
      this.showFilePicker("save");
    }

    openFileDialog() {
      this.showFilePicker("open");
    }

    // ── File Picker Modal (Open & Save) ──────────────────────────────────

    showFilePicker(mode) {
      var self = this;
      this._pickerMode = mode || "open";
      var overlay = document.getElementById("file-picker-overlay");
      overlay.classList.remove("hidden");

      // Set title & button based on mode
      var isSave = (mode === "save");
      document.querySelector("#file-picker .modal-header span").textContent = isSave ? "💾 Save File" : "📂 Open File";
      var actionBtn = document.getElementById("btn-picker-open");
      actionBtn.textContent = isSave ? "Save" : "Open";
      actionBtn.className = isSave ? "btn-primary" : "btn-primary";

      document.getElementById("picker-input").value = "";
      self._pickerSelected = null;
      self._pickerDir = null;
      var homeDir = self._homeDir || "/home/admin";
      self._loadPickerDir(homeDir);
      document.getElementById("picker-input").placeholder = isSave ? "Enter filename..." : "Filename or full path...";
      document.getElementById("picker-input").focus();

      // Close handlers
      function close() { overlay.classList.add("hidden"); }
      document.getElementById("btn-picker-close").onclick = close;
      document.getElementById("btn-picker-cancel").onclick = close;
      overlay.onclick = function (e) { if (e.target === overlay) close(); };

      // Action button (Open or Save)
      actionBtn.onclick = function () {
        var input = document.getElementById("picker-input").value.trim();
        if (isSave) {
          // Combine current directory + filename
          var name = input;
          if (!name) return;
          var dir = self._pickerDir || homeDir;
          var fullPath = name.startsWith("/") ? name : dir + "/" + name;
          close();
          self._doSave(fullPath);
        } else {
          var target = input || self._pickerSelected;
          if (target) { close(); self.loadFile(target); }
        }
      };

      // Keyboard
      var input = document.getElementById("picker-input");
      input.onkeydown = function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          var val = input.value.trim();
          if (isSave) {
            if (val) {
              var dir = self._pickerDir || homeDir;
              var fullPath = val.startsWith("/") ? val : dir + "/" + val;
              close();
              self._doSave(fullPath);
            }
          } else {
            if (val) self._pickerSelected = val;
            if (self._pickerSelected) { close(); self.loadFile(self._pickerSelected); }
          }
        } else if (e.key === "Escape") {
          e.stopPropagation(); close();
        }
      };

      // Global Escape
      function onKey(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } }
      document.addEventListener("keydown", onKey);
    }

    _doSave(path) {
      var self = this;
      var content = self.cm.getValue();
      fetch("/api/save-as", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path, content: content }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) {
            var tab = self.tabs.find(function (t) { return t.id === self.activeTabId; });
            if (tab) {
              tab.path = data.path;
              tab.title = data.path.split("/").pop();
              tab.content = content;
              self._setEditorMode(data.path);
              self.markClean();
              self.updateStatus();
              self.updatePreview();
            }
          } else {
            alert("Save failed: " + (data.error || "Unknown error"));
          }
        })
        .catch(function (err) { alert("Save failed: " + err.message); });
    }

    async _loadPickerDir(dirPath) {
      var self = this;
      self._pickerDir = dirPath;
      var list = document.getElementById("picker-file-list");
      var bread = document.getElementById("picker-breadcrumb");
      list.innerHTML = '<div class="picker-item"><span class="p-icon">⏳</span> Loading...</div>';

      // Breadcrumb
      var parts = dirPath.split("/").filter(Boolean);
      var cum = "";
      bread.innerHTML = '<span class="crumb" data-path="/">🏠</span>';
      parts.forEach(function (p) {
        cum += "/" + p;
        bread.innerHTML += '<span class="crumb-sep">▸</span>';
        bread.innerHTML += '<span class="crumb" data-path="' + self._esc(cum) + '">' + self._esc(p) + '</span>';
      });
      bread.querySelectorAll(".crumb").forEach(function (c) {
        c.onclick = function () { self._loadPickerDir(c.dataset.path); };
      });

      try {
        var res = await fetch("/api/files?dir=" + encodeURIComponent(dirPath));
        var data = await res.json();
        if (data.error) {
          list.innerHTML = '<div class="picker-item">❌ ' + self._esc(data.error) + '</div>';
          return;
        }
        list.innerHTML = "";
        data.items.forEach(function (item) {
          var el = document.createElement("div");
          el.className = "picker-item";
          var icon = item.isDir ? "📁" : self._getFileIcon(item.name);
          var sizeStr = item.isDir ? "" : self._formatSize(item.size);
          el.innerHTML = '<span class="p-icon">' + icon + '</span><span class="p-name">' + self._esc(item.name) + '</span><span class="p-size">' + sizeStr + '</span>';
          el.onclick = function () {
            if (item.isDir) {
              self._loadPickerDir(item.path);
            } else {
              list.querySelectorAll(".picker-item").forEach(function (e) { e.classList.remove("selected"); });
              el.classList.add("selected");
              self._pickerSelected = item.path;
              if (self._pickerMode === "save") {
                // In save mode, fill just the filename
                document.getElementById("picker-input").value = item.name;
              } else {
                document.getElementById("picker-input").value = item.path;
              }
            }
          };
          el.ondblclick = function () {
            if (item.isDir) {
              self._loadPickerDir(item.path);
            } else if (self._pickerMode === "open") {
              document.getElementById("file-picker-overlay").classList.add("hidden");
              self.loadFile(item.path);
            } else {
              // Save mode: use the filename
              document.getElementById("picker-input").value = item.name;
            }
          };
          list.appendChild(el);
        });
      } catch (err) {
        list.innerHTML = '<div class="picker-item">❌ ' + self._esc(err.message) + '</div>';
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
      var self = this;
      if (!self.cm) return;
      CodeMirror.commands.find(self.cm);
      // Focus the search input + bind Enter to find-next
      setTimeout(function () {
        var input = document.querySelector(".CodeMirror-dialog input");
        if (input) {
          input.focus();
          // Ensure Enter does find-next (CodeMirror does this, but reinforce)
          input.onkeydown = function (e) {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              if (e.shiftKey) {
                CodeMirror.commands.findPrev(self.cm);
              } else {
                CodeMirror.commands.findNext(self.cm);
              }
            }
          };
        }
      }, 60);
    }

    showReplace() {
      var self = this;
      if (!self.cm) return;
      CodeMirror.commands.replace(self.cm);
      setTimeout(function () {
        var inputs = document.querySelectorAll(".CodeMirror-dialog input");
        if (inputs.length > 0) inputs[0].focus();
      }, 60);
    }

    findNext(backward) {
      if (!this.cm) return;
      if (backward) {
        CodeMirror.commands.findPrev(this.cm);
      } else {
        CodeMirror.commands.findNext(this.cm);
      }
    }

    showMdHelp() {
      var overlay = document.getElementById("md-help-overlay");
      overlay.classList.remove("hidden");
      overlay.onclick = function (e) {
        if (e.target === overlay) overlay.classList.add("hidden");
      };
      var onKey = function (e) {
        if (e.key === "Escape") {
          overlay.classList.add("hidden");
          document.removeEventListener("keydown", onKey);
        }
      };
      document.addEventListener("keydown", onKey);
      document.getElementById("btn-md-help-close").onclick = function () {
        overlay.classList.add("hidden");
      };
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

    // ── Status bar ───────────────────────────────────────────────────

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
