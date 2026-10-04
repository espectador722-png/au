#!/usr/bin/env python3
# =============================================================
# deploy.py — Eclipse Zone
# Despliega el sitio estático y/o el Worker a Cloudflare
#
# USO:
#   python deploy.py              → genera sitio + deploy Pages
#   python deploy.py --worker     → solo el Worker (wrangler deploy)
#   python deploy.py --pages      → solo el sitio estático
#   python deploy.py --dry-run    → muestra los comandos sin ejecutar
# =============================================================

import subprocess
import sys
import os
import argparse
import shutil
import io
from pathlib import Path
from datetime import datetime

# La consola de Windows usa cp1252 por defecto, que no puede codificar
# los caracteres Unicode de las cajas/separadores de este script
# (═, ─) ni los emojis — sin esto, python deploy.py --changelog "..."
# crashea con UnicodeEncodeError apenas imprime el primer separador,
# ANTES de llegar a ejecutar ningún paso real del deploy.
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# ─── CONFIGURACIÓN ───────────────────────────────────────────

PAGES_PROJECT   = "eclipse"
PAGES_BRANCH    = "EclipseZone"
PUBLIC_DIR      = "./public"
GENERATE_SCRIPT = "generate-everything.js"
WRANGLER_TOML   = "wrangler.toml"

# ─── COLORES PARA CONSOLA ────────────────────────────────────

class C:
    OK     = "\033[92m"
    WARN   = "\033[93m"
    ERR    = "\033[91m"
    INFO   = "\033[96m"
    BOLD   = "\033[1m"
    RESET  = "\033[0m"

def ok(msg):   print(f"{C.OK}[OK]   {C.RESET}{msg}")
def warn(msg): print(f"{C.WARN}[WARN] {C.RESET}{msg}")
def err(msg):  print(f"{C.ERR}[ERR]  {C.RESET}{msg}")
def info(msg): print(f"{C.INFO}[INFO] {C.RESET}{msg}")
def sep():     print(f"{C.BOLD}{'─' * 50}{C.RESET}")

# ─── HELPERS ─────────────────────────────────────────────────

def resolve_wrangler():
    """Devuelve el comando wrangler correcto para este sistema."""
    if shutil.which("wrangler"):
        return ["wrangler"]
    if shutil.which("npx"):
        return ["npx", "wrangler"]
    return ["wrangler"]


def run(cmd, dry_run=False, cwd=None):
    """Ejecuta un comando y muestra output en tiempo real."""
    info(f"$ {' '.join(cmd)}")

    if dry_run:
        warn("DRY-RUN: comando no ejecutado.")
        return True

    use_shell = (sys.platform == "win32")
    try:
        subprocess.run(
            cmd,
            cwd=cwd or os.getcwd(),
            check=True,
            text=True,
            shell=use_shell,
        )
        return True
    except subprocess.CalledProcessError as e:
        err(f"Falló con código {e.returncode}")
        if hasattr(e, 'stderr') and e.stderr:
            print(e.stderr.rstrip())
        return False
    except FileNotFoundError:
        err(f"Comando no encontrado: {cmd[0]}")
        err("¿Está instalado? Ejecutá: npm install -g wrangler")
        return False


def check_tool(name):
    if shutil.which(name):
        ok(f"{name} encontrado.")
        return True
    else:
        err(f"{name} NO está instalado.")
        return False


def check_file(path, label):
    if os.path.exists(path):
        ok(f"{label} encontrado: {path}")
        return True
    else:
        err(f"{label} no encontrado: {path}")
        return False


# ─── PASOS DE DEPLOY ─────────────────────────────────────────

def step_generate(dry_run, step_num):
    sep()
    print(f"\n{C.BOLD}📦 PASO {step_num} — Generando sitio estático{C.RESET}\n")

    if not check_file(GENERATE_SCRIPT, "generate-everything.js"):
        return False

    success = run(["node", GENERATE_SCRIPT], dry_run=dry_run)
    if success:
        ok("Sitio estático generado en ./public")
    return success


def step_deploy_pages(dry_run, step_num):
    sep()
    print(f"\n{C.BOLD}🚀 PASO {step_num} — Deploy a Cloudflare Pages{C.RESET}\n")

    if not check_file(PUBLIC_DIR, "Directorio public/"):
        err("Ejecutá primero el paso de generación.")
        return False

    wrangler = resolve_wrangler()
    cmd = wrangler + [
        "pages", "deploy", PUBLIC_DIR,
        "--project-name", PAGES_PROJECT,
        "--branch",       PAGES_BRANCH,
    ]
    success = run(cmd, dry_run=dry_run)
    if success:
        ok("Pages desplegado → https://eclipsezonehub.com")
    return success


def step_deploy_worker(dry_run, step_num):
    sep()
    print(f"\n{C.BOLD}⚙️  PASO {step_num} — Deploy del Worker{C.RESET}\n")

    if not check_file(WRANGLER_TOML, "wrangler.toml"):
        return False
    if not check_file("worker.js", "worker.js"):
        return False

    wrangler = resolve_wrangler()
    success = run(wrangler + ["deploy"], dry_run=dry_run)
    if success:
        ok("Worker desplegado → eclipsezonehub.com/api/*")
    return success


# ─── VERIFICACIONES PREVIAS ───────────────────────────────────

def preflight():
    sep()
    print(f"\n{C.BOLD}🔍 Verificaciones previas{C.RESET}\n")
    ok_node     = check_tool("node")
    ok_wrangler = check_tool("wrangler")
    print()
    if not ok_node:
        err("Instalá Node.js desde https://nodejs.org/")
    if not ok_wrangler:
        err("Instalá Wrangler con: npm install -g wrangler")
        err("Luego autenticáte con: wrangler login")
    return ok_node and ok_wrangler


# ─── REPORTE FINAL ────────────────────────────────────────────

def report(results, elapsed):
    sep()
    print(f"\n{C.BOLD}📋 REPORTE FINAL{C.RESET}\n")
    icons = {True: f"{C.OK}✅{C.RESET}", False: f"{C.ERR}❌{C.RESET}"}
    for label, success in results.items():
        print(f"  {icons[success]}  {label}")
    print(f"\n  ⏱  Tiempo total: {elapsed:.1f}s")
    all_ok = all(results.values())
    if all_ok:
        print(f"\n{C.OK}{C.BOLD}  ¡Deploy completo!{C.RESET}")
        print(f"  🌐 Sitio:   https://eclipsezonehub.com")
        print(f"  🗺  Sitemap: https://eclipsezonehub.com/sitemap.xml\n")
    else:
        print(f"\n{C.ERR}{C.BOLD}  Algunos pasos fallaron. Revisá los errores arriba.{C.RESET}\n")
    return all_ok


# ─── MAIN ─────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Deploy Eclipse Zone a Cloudflare")
    parser.add_argument("--worker",   action="store_true", help="Solo deployar el Worker (wrangler deploy)")
    parser.add_argument("--pages",    action="store_true", help="Solo deployar Pages (genera + sube)")
    parser.add_argument("--dry-run",  action="store_true", help="Mostrar comandos sin ejecutar")
    parser.add_argument("--changelog", default="",
                         help="Si se pasa, anuncia en Discord (vía AnnounceUpdate) al terminar un deploy exitoso.")
    parser.add_argument("--version", default="",
                         help="Versión a anunciar (ej. 2.8.0) — requerida junto con --changelog: "
                              "el intro real de Main dice 'la versión vX.X.X del eclipse zone ya "
                              "fue liberada'.")
    args = parser.parse_args()

    if args.changelog.strip() and not args.version.strip():
        parser.error("--version es requerida junto con --changelog.")

    dry = args.dry_run
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    print(f"\n{C.BOLD}{'═' * 50}")
    print(f"  🌑 Eclipse Zone — Deploy Script")
    print(f"  {now}{'  [DRY-RUN]' if dry else ''}")
    print(f"{'═' * 50}{C.RESET}\n")

    # ── Solo worker ──────────────────────────────────────────
    if args.worker and not args.pages:
        if not preflight(): sys.exit(1)
        start = datetime.now()
        results = {"Worker (wrangler deploy)": step_deploy_worker(dry, step_num=1)}
        elapsed = (datetime.now() - start).total_seconds()
        report(results, elapsed)
        ok = all(results.values())
        if ok and not dry:
            _anunciar_en_discord(args.changelog, args.version)
        sys.exit(0 if ok else 1)

    # ── Solo pages ───────────────────────────────────────────
    if args.pages and not args.worker:
        if not preflight(): sys.exit(1)
        start = datetime.now()
        ok_g  = step_generate(dry, step_num=1)
        ok_p  = step_deploy_pages(dry, step_num=2) if ok_g else False
        elapsed = (datetime.now() - start).total_seconds()
        report({
            "Generar sitio (node generate-everything.js)": ok_g,
            "Deploy Pages (wrangler pages deploy)":        ok_p,
        }, elapsed)
        ok = ok_g and ok_p
        if ok and not dry:
            _anunciar_en_discord(args.changelog, args.version)
        sys.exit(0 if ok else 1)

    # ── Todo junto (default) ─────────────────────────────────
    if not preflight(): sys.exit(1)
    start = datetime.now()
    ok_g  = step_generate(dry, step_num=1)
    ok_p  = step_deploy_pages(dry, step_num=2) if ok_g else False
    elapsed = (datetime.now() - start).total_seconds()
    report({
        "Generar sitio (node generate-everything.js)": ok_g,
        "Deploy Pages (wrangler pages deploy)":        ok_p,
    }, elapsed)
    ok = ok_g and ok_p
    if ok and not dry:
        _anunciar_en_discord(args.changelog, args.version)
    sys.exit(0 if ok else 1)


def _anunciar_en_discord(changelog: str, version: str = "") -> None:
    """Anuncio automático en Discord si se pasó --changelog — script
    aparte, deliberadamente desacoplado de eclipse-main (ver
    AnnounceUpdate/announce_update.py, pedido explícito del usuario
    2026-09-09). No bloquea el resultado del deploy si falla."""
    changelog = (changelog or "").strip()
    if not changelog:
        return
    # eclipse-main/ y Eclipse-Source/ son carpetas HERMANAS dentro de
    # General/ (no una dentro de la otra) — parents[2] desde
    # scripts/deploy.py sube a General/, ahí vive Eclipse-Source/.
    script = Path(__file__).resolve().parents[2] / "Eclipse-Source" / "AnnounceUpdate" / "announce_update.py"
    if not script.exists():
        print(f"[Discord] No se encontró {script} — se omite el anuncio.")
        return
    try:
        resultado = subprocess.run(
            [sys.executable, str(script), "--proyecto", "main",
             "--version", version, "--changelog", changelog],
            capture_output=True, text=True, timeout=600,  # long changelogs are split into many messages per channel
        )
        print(resultado.stdout)
        if resultado.returncode != 0:
            print(resultado.stderr)
    except Exception as e:
        print(f"[Discord] No se pudo anunciar la actualización: {e}")


if __name__ == "__main__":
    main()
