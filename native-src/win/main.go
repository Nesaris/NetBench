// Fenêtre native de NetBench pour Windows : une vraie app (barre des tâches, icône), sans navigateur.
// Elle affiche l'interface locale dans WebView2, le moteur web du système (inclus dans Windows 10/11).
// Première ouverture de l'exécutable téléchargé : installe le moteur (Node.js vérifié + paquet signé).
package main

import (
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
)

const base = "http://127.0.0.1:47800"
const installCmd = "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Nesaris/NetBench/main/install/win.ps1))) -NoLaunch"

var (
	root    = filepath.Join(os.Getenv("LOCALAPPDATA"), "Sonde", "app")
	dataDir = filepath.Join(os.Getenv("APPDATA"), "Sonde")
	hidden  = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
)

func up() bool {
	c := http.Client{Timeout: 800 * time.Millisecond}
	r, err := c.Get(base + "/")
	if err != nil {
		return false
	}
	r.Body.Close()
	return true
}
func installed() bool { _, err := os.Stat(filepath.Join(root, "launcher.js")); return err == nil }

func install() bool {
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := exec.Command(ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", installCmd)
	cmd.SysProcAttr = hidden
	return cmd.Run() == nil && installed()
}
func startEngine() {
	if up() {
		return
	}
	cmd := exec.Command(filepath.Join(root, "node", "node.exe"), filepath.Join(root, "launcher.js"))
	cmd.Dir = root
	cmd.SysProcAttr = hidden
	_ = cmd.Start() // le moteur continue de tourner après la fermeture de la fenêtre, comme sur Mac
	for i := 0; i < 75 && !up(); i++ {
		time.Sleep(200 * time.Millisecond)
	}
}
func page(title, text string) string {
	return `<!doctype html><meta charset=utf-8><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8ea;font:15px 'Segoe UI',sans-serif"><div style="text-align:center;max-width:460px;line-height:1.5"><h2 style="font-weight:600">` + title + `</h2><p style="color:#9aa1a9">` + text + `</p></div>`
}
func openExternal(u string) {
	p, err := url.Parse(u)
	if err != nil || (p.Scheme != "http" && p.Scheme != "https") {
		return
	}
	shell32 := syscall.NewLazyDLL("shell32.dll")
	verb, _ := syscall.UTF16PtrFromString("open")
	target, _ := syscall.UTF16PtrFromString(p.String())
	shell32.NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(target)), 0, 0, 1)
}
func msg(text string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString("NetBench")
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x40)
}

func main() {
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		DataPath:  filepath.Join(os.Getenv("LOCALAPPDATA"), "Sonde", "webview"),
		WindowOptions: webview2.WindowOptions{Title: "NetBench", Width: 1480, Height: 940, IconId: 1, Center: true},
	})
	if w == nil {
		msg("NetBench a besoin du composant Microsoft Edge WebView2, inclus dans Windows 11 et dans Windows 10 à jour.\n\nInstalle-le depuis https://go.microsoft.com/fwlink/p/?LinkId=2124703 puis rouvre NetBench.")
		openExternal("https://go.microsoft.com/fwlink/p/?LinkId=2124703")
		return
	}
	defer w.Destroy()
	// Les liens vers l'extérieur s'ouvrent dans le navigateur par défaut ; « Quitter » ferme la fenêtre
	w.Bind("__rebondOpen", func(u string) { openExternal(u) })
	w.Bind("__rebondQuit", func() { w.Dispatch(func() { w.Terminate() }) })
	w.Init(`(()=>{const ext=u=>{try{const x=new URL(u,location.href);if(x.origin!=="` + base + `")return __rebondOpen(x.href),true}catch(e){}return false};
document.addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('a[href]');if(a&&ext(a.href))e.preventDefault()},true);
window.open=u=>{ext(String(u));return null};window.close=()=>__rebondQuit();})()`)
	w.SetHtml(page("NetBench", "Démarrage du moteur de mesure…"))
	go func() {
		if !installed() {
			w.Dispatch(func() {
				w.SetHtml(page("Installation de NetBench", "Téléchargement de Node.js (empreinte vérifiée) et du moteur de NetBench (signature vérifiée). Une minute environ."))
			})
			if !install() {
				w.Dispatch(func() { w.SetHtml(page("Installation impossible", "Vérifie la connexion Internet puis rouvre NetBench.")) })
				return
			}
		}
		startEngine()
		key, _ := os.ReadFile(filepath.Join(dataDir, "ui.key"))
		k := url.QueryEscape(strings.TrimSpace(string(key)))
		w.Dispatch(func() { w.Navigate(base + "/?k=" + k) })
	}()
	w.Run()
}
