'use strict';

/*
 * Local HTML View
 *
 * Opens .html and .htm files from your vault in a real browser view instead of
 * a sanitized preview, so scripts, styles, canvas and event handlers keep working.
 *
 * This uses an Electron <webview>, which runs in its own renderer process and
 * loads the file over file://. When the user forces it, or when the webview
 * element is unavailable, it falls back to an <iframe> loaded over Obsidian's
 * app:// resource protocol. The webview makes the plugin desktop only.
 */

const obsidian = require('obsidian');

const VIEW_TYPE_HTML = 'local-html-view';
const EXTENSIONS = ['html', 'htm'];
const DEFAULT_SETTINGS = { forceIframe: false, zoom: 1 };
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;

/** Electron's shell. Returns null when it cannot be reached. */
function electronShell() {
  if (!obsidian.Platform.isDesktopApp) return null;
  try {
    const req = window.require;
    if (typeof req !== 'function') return null;
    return req('electron').shell || null;
  } catch (e) {
    return null;
  }
}

/** Links that should leave the embedded page and go to the OS handler. */
function isExternalUrl(url) {
  return /^(obsidian|https?|mailto):/i.test(url || '');
}

class LocalHtmlView extends obsidian.FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.frame = null;
    this.usingWebview = false;
    this.modeEl = null;
    this.zoom = plugin.settings.zoom || 1;
  }

  getViewType() {
    return VIEW_TYPE_HTML;
  }

  getIcon() {
    return 'globe';
  }

  getDisplayText() {
    return this.file ? this.file.basename : 'HTML';
  }

  canAcceptExtension(ext) {
    return EXTENSIONS.indexOf(ext) !== -1;
  }

  async onLoadFile(file) {
    this.contentEl.empty();
    this.contentEl.addClass('local-html-view');
    this.buildToolbar(file);
    this.buildFrame(file);
  }

  async onUnloadFile() {
    this.contentEl.empty();
    this.frame = null;
    this.modeEl = null;
  }

  /*
   * A webview is a separate renderer process with its own session, so it cannot
   * resolve Obsidian's privileged app:// protocol and must use file://.
   * An iframe runs inside the main window, where file:// is blocked by the
   * content security policy, so it has to use app:// instead.
   */
  fileUrl(file) {
    return 'file://' + this.absPath(file).split('/').map(encodeURIComponent).join('/');
  }

  resourceUrl(file) {
    return this.app.vault.adapter.getResourcePath(file.path);
  }

  absPath(file) {
    const adapter = this.app.vault.adapter;
    const base = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : '';
    return base ? base + '/' + file.path : file.path;
  }

  buildToolbar(file) {
    const bar = this.contentEl.createDiv({ cls: 'local-html-view-bar' });

    const addButton = (icon, label, handler) => {
      const button = bar.createEl('button', { cls: 'clickable-icon' });
      obsidian.setIcon(button, icon);
      button.setAttribute('aria-label', label);
      button.addEventListener('click', handler);
      return button;
    };

    addButton('rotate-ccw', 'Reload page', () => this.reload());
    addButton('zoom-out', 'Zoom out', () => this.setZoom(this.zoom - 0.1));
    addButton('zoom-in', 'Zoom in', () => this.setZoom(this.zoom + 0.1));
    addButton('refresh-cw', 'Reset zoom', () => this.setZoom(1));

    bar.createDiv({ cls: 'local-html-view-spacer' });
    this.modeEl = bar.createSpan({ cls: 'local-html-view-mode' });

    addButton('external-link', 'Open in default browser', () => {
      const shell = electronShell();
      if (shell) shell.openExternal(this.fileUrl(file));
      else window.open(this.resourceUrl(file));
    });
  }

  buildFrame(file) {
    const host = this.contentEl.createDiv({ cls: 'local-html-view-frame' });
    const useWebview = obsidian.Platform.isDesktopApp && !this.plugin.settings.forceIframe;

    if (useWebview) {
      const doc = this.contentEl.ownerDocument || document;
      const webview = doc.createElement('webview');
      // The partition has to be assigned before the element is attached,
      // otherwise the webview falls back to the default session.
      webview.partition = 'persist:vault-' + this.app.appId;
      host.appendChild(webview);
      this.registerDomEvent(webview, 'dom-ready', () => this.applyZoom());
      this.registerDomEvent(webview, 'will-navigate', (event) => this.interceptNav(event));
      this.registerDomEvent(webview, 'new-window', (event) => this.interceptNav(event));
      // Electron only starts loading once src is set on an attached element.
      webview.setAttribute('src', this.fileUrl(file));
      this.frame = webview;
      this.usingWebview = true;
    } else {
      const iframe = host.createEl('iframe');
      iframe.setAttribute('src', this.resourceUrl(file));
      this.frame = iframe;
      this.usingWebview = false;
      this.applyZoom();
    }

    if (this.modeEl) this.modeEl.setText(this.usingWebview ? 'webview' : 'iframe');
  }

  /*
   * obsidian:// links cannot be resolved inside the embedded page, so they are
   * handed to the operating system handler, which routes them back to Obsidian.
   */
  interceptNav(event) {
    const url = event && event.url;
    if (!isExternalUrl(url)) return;
    if (event.preventDefault) event.preventDefault();
    const shell = electronShell();
    if (shell) shell.openExternal(url);
  }

  applyZoom() {
    if (!this.frame) return;
    if (this.usingWebview) {
      try {
        this.frame.setZoomFactor(this.zoom);
      } catch (e) {
        // The renderer process is not ready yet; dom-ready will apply it.
      }
    } else {
      // The zoom factor is handed to CSS as a custom property so the actual
      // rules stay in styles.css and remain overridable by themes.
      this.frame.style.setProperty('--local-html-view-zoom', String(this.zoom));
    }
  }

  async setZoom(value) {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
    this.zoom = clamped;
    this.plugin.settings.zoom = clamped;
    await this.plugin.saveSettings();
    this.applyZoom();
  }

  reload() {
    if (!this.frame) return;
    if (this.usingWebview) {
      try {
        this.frame.reload();
        return;
      } catch (e) {
        // Fall through to the attribute based reload below.
      }
    }
    const src = this.frame.getAttribute('src');
    this.frame.setAttribute('src', '');
    this.frame.setAttribute('src', src);
  }
}

class LocalHtmlViewSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new obsidian.Setting(containerEl)
      .setName('Always use iframe')
      .setDesc(
        'Render pages in an iframe instead of a webview. Enable this if a page fails to load in the webview. Reopen the tab to apply.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.forceIframe).onChange(async (value) => {
          this.plugin.settings.forceIframe = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Take over HTML files')
      .setDesc('Re-register .html and .htm with this plugin if another plugin has claimed them.')
      .addButton((button) =>
        button.setButtonText('Take over').onClick(() => {
          this.plugin.takeOverExtensions();
          new obsidian.Notice('Local HTML View now handles .html and .htm files.');
        })
      );
  }
}

class LocalHtmlViewPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.previousOwner = {};

    this.registerView(VIEW_TYPE_HTML, (leaf) => new LocalHtmlView(leaf, this));
    this.addSettingTab(new LocalHtmlViewSettingTab(this.app, this));

    // Another HTML plugin may register the same extensions after this one loads,
    // so the claim is re-checked twice and then left alone. There is no polling.
    this.takeOverExtensions();
    this.app.workspace.onLayoutReady(() => this.takeOverExtensions());
    this.recheckTimer = window.setTimeout(() => {
      this.recheckTimer = null;
      this.takeOverExtensions();
    }, 2000);

    this.addCommand({
      id: 'toggle-render-mode',
      name: 'Toggle render mode between webview and iframe',
      callback: async () => {
        this.settings.forceIframe = !this.settings.forceIframe;
        await this.saveSettings();
        new obsidian.Notice(
          this.settings.forceIframe
            ? 'Local HTML View: switched to iframe. Reopen the tab to apply.'
            : 'Local HTML View: switched to webview. Reopen the tab to apply.'
        );
      },
    });

    this.addCommand({
      id: 'take-over-html-files',
      name: 'Take over HTML files',
      callback: () => {
        this.takeOverExtensions();
        new obsidian.Notice('Local HTML View now handles .html and .htm files.');
      },
    });
  }

  onunload() {
    if (this.recheckTimer) {
      window.clearTimeout(this.recheckTimer);
      this.recheckTimer = null;
    }
    const registry = this.app.viewRegistry;
    if (!registry || !registry.typeByExtension) return;
    for (const ext of Object.keys(this.previousOwner)) {
      if (registry.typeByExtension[ext] === VIEW_TYPE_HTML) {
        delete registry.typeByExtension[ext];
      }
      registry.typeByExtension[ext] = this.previousOwner[ext];
    }
  }

  takeOverExtensions() {
    const registry = this.app.viewRegistry;
    if (!registry || !registry.typeByExtension) {
      try {
        this.registerExtensions(EXTENSIONS, VIEW_TYPE_HTML);
      } catch (e) {
        // Already registered by this plugin.
      }
      return;
    }
    for (const ext of EXTENSIONS) {
      const owner = registry.typeByExtension[ext];
      if (owner === VIEW_TYPE_HTML) continue;
      if (owner !== undefined) {
        if (!(ext in this.previousOwner)) this.previousOwner[ext] = owner;
        delete registry.typeByExtension[ext];
      }
      try {
        this.registerExtensions([ext], VIEW_TYPE_HTML);
      } catch (e) {
        new obsidian.Notice('Local HTML View could not take over .' + ext + ' files.');
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = LocalHtmlViewPlugin;
