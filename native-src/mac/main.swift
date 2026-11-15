// Fenêtre native de NetBench pour macOS : une vraie app (Dock, menu, ⌘Q), sans navigateur.
// Elle démarre le moteur (agent launchd de l'utilisateur) s'il ne tourne pas, puis affiche l'interface
// locale dans une vue WebKit du système, avec la clé d'accès de l'interface (ui.key).
import Cocoa
import WebKit

let PORT = 47800
let LABEL = "fr.nesaris.sonde"
let SUP = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/Sonde")
let BASE = "http://127.0.0.1:\(PORT)"

func engineUp() -> Bool {
  var ok = false
  let sem = DispatchSemaphore(value: 0)
  var req = URLRequest(url: URL(string: BASE + "/")!); req.timeoutInterval = 0.8
  URLSession.shared.dataTask(with: req) { _, r, _ in ok = (r as? HTTPURLResponse) != nil; sem.signal() }.resume()
  _ = sem.wait(timeout: .now() + 1.2)
  return ok
}
func run(_ path: String, _ args: [String]) {
  let p = Process(); p.executableURL = URL(fileURLWithPath: path); p.arguments = args
  p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
  try? p.run(); p.waitUntilExit()
}
let ROOT = (SUP as NSString).appendingPathComponent("app")
var installed: Bool { FileManager.default.fileExists(atPath: (ROOT as NSString).appendingPathComponent("launcher.js")) }
// Première ouverture de l'app téléchargée : installe le moteur (Node.js vérifié + paquet signé), sans recréer d'icône
func install() -> Bool {
  let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/bash")
  p.arguments = ["-c", "set -o pipefail; /usr/bin/curl -fsSL https://raw.githubusercontent.com/Nesaris/netbench/main/install/mac.sh | /bin/bash -s -- --no-app"]
  p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
  do { try p.run() } catch { return false }
  p.waitUntilExit(); return p.terminationStatus == 0 && installed
}
func page(_ title: String, _ text: String) -> String {
  "<!doctype html><meta charset=utf-8><body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8ea;font:15px -apple-system,sans-serif\"><div style=\"text-align:center;max-width:460px;line-height:1.5\"><h2 style=\"font-weight:600\">\(title)</h2><p style=\"color:#9aa1a9\">\(text)</p></div>"
}
func startEngine() {
  if engineUp() { return }
  let uid = getuid()
  run("/bin/launchctl", ["kickstart", "gui/\(uid)/\(LABEL)"])
  if !engineUp() { run("/bin/launchctl", ["bootstrap", "gui/\(uid)", (NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents/\(LABEL).plist")]) }
  for _ in 0..<60 { if engineUp() { return }; Thread.sleep(forTimeInterval: 0.2) }
}

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
  var win: NSWindow!
  var web: WKWebView!

  func applicationDidFinishLaunching(_ n: Notification) {
    buildMenu()
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .nonPersistent() // rien n'est gardé hors de l'app ; la session tient par la clé locale
    web = WKWebView(frame: .zero, configuration: cfg)
    web.navigationDelegate = self; web.uiDelegate = self
    web.setValue(false, forKey: "drawsBackground")
    win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1480, height: 940), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    win.title = "NetBench"; win.titlebarAppearsTransparent = true; win.appearance = NSAppearance(named: .darkAqua)
    win.backgroundColor = NSColor(red: 0.043, green: 0.051, blue: 0.063, alpha: 1)
    win.minSize = NSSize(width: 980, height: 640)
    win.contentView = web; win.delegate = self
    win.center(); win.setFrameAutosaveName("NetBenchMain")
    win.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    web.loadHTMLString(page("NetBench", "Démarrage du moteur de mesure…"), baseURL: nil)
    DispatchQueue.global().async {
      if !installed {
        DispatchQueue.main.async { self.web.loadHTMLString(page("Installation de NetBench", "Téléchargement de Node.js (empreinte vérifiée) et du moteur de NetBench (signature vérifiée). Une minute environ."), baseURL: nil) }
        if !install() { DispatchQueue.main.async { self.web.loadHTMLString(page("Installation impossible", "Vérifie la connexion Internet puis rouvre NetBench."), baseURL: nil) }; return }
      }
      startEngine()
      let key = (try? String(contentsOfFile: (SUP as NSString).appendingPathComponent("ui.key"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let q = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
      DispatchQueue.main.async { self.web.load(URLRequest(url: URL(string: BASE + "/?k=" + q)!)) }
    }
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

  // Seule l'interface locale s'affiche dans la fenêtre ; tout autre lien s'ouvre à part, dans le navigateur par défaut
  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if let u = a.request.url, (u.host == "127.0.0.1" && u.port == PORT) || u.scheme == "about" { return decisionHandler(.allow) }
    if let u = a.request.url, ["http", "https"].contains(u.scheme ?? "") { NSWorkspace.shared.open(u) }
    decisionHandler(.cancel)
  }
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
    if let u = a.request.url, ["http", "https"].contains(u.scheme ?? "") { NSWorkspace.shared.open(u) }
    return nil
  }
  func webViewDidClose(_ w: WKWebView) { NSApp.terminate(nil) } // bouton « Quitter » de l'interface
  func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { retry() }
  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { retry() }
  func retry() { DispatchQueue.global().asyncAfter(deadline: .now() + 1) { startEngine(); DispatchQueue.main.async { self.web.reload() } } }
  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let al = NSAlert(); al.messageText = m; al.runModal(); completionHandler()
  }
  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let al = NSAlert(); al.messageText = m; al.addButton(withTitle: "OK"); al.addButton(withTitle: "Annuler"); completionHandler(al.runModal() == .alertFirstButtonReturn)
  }

  func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem(); main.addItem(appItem)
    let am = NSMenu()
    am.addItem(withTitle: "À propos de NetBench", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    am.addItem(.separator())
    am.addItem(withTitle: "Masquer NetBench", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    am.addItem(.separator())
    am.addItem(withTitle: "Quitter NetBench", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = am
    let editItem = NSMenuItem(); main.addItem(editItem)
    let em = NSMenu(title: "Édition")
    em.addItem(withTitle: "Annuler", action: Selector(("undo:")), keyEquivalent: "z")
    em.addItem(withTitle: "Rétablir", action: Selector(("redo:")), keyEquivalent: "Z")
    em.addItem(.separator())
    em.addItem(withTitle: "Couper", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    em.addItem(withTitle: "Copier", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    em.addItem(withTitle: "Coller", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    em.addItem(withTitle: "Tout sélectionner", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = em
    let viewItem = NSMenuItem(); main.addItem(viewItem)
    let vm = NSMenu(title: "Présentation")
    vm.addItem(withTitle: "Recharger", action: #selector(reload), keyEquivalent: "r")
    vm.addItem(withTitle: "Plein écran", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
    viewItem.submenu = vm
    let winItem = NSMenuItem(); main.addItem(winItem)
    let wm = NSMenu(title: "Fenêtre")
    wm.addItem(withTitle: "Réduire", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
    wm.addItem(withTitle: "Fermer", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    winItem.submenu = wm
    NSApp.mainMenu = main; NSApp.windowsMenu = wm
  }
  @objc func reload() { web.reload() }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
