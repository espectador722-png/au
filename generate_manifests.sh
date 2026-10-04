#!/usr/bin/env bash
# ============================================================
# generate_manifests.sh — Eclipse Zone
# Genera manifest.json en cada carpeta de assets.
# Limpia manifests existentes antes de regenerar.
#
# USO:
#   bash generate_manifests.sh
#
# GitLab CI (.gitlab-ci.yml):
#
#   generate-manifests:
#     script:
#       - bash generate_manifests.sh
#     artifacts:
#       paths:
#         - "*/manifest.json"
#
# Carpetas soportadas (archivos directamente en la raíz, sin subcarpetas):
#   avatar_por_defecto/   → png, gif, jpg, jpeg, webp
#   avatar/               → png, gif, jpg, jpeg, webp
#   efecto_perfil/        → png, gif, jpg, jpeg, webp
#   emojis/               → png, gif, jpg, jpeg, webp
#   placa_nombre/         → png, gif, jpg, jpeg, webp
#   stickers/             → png, gif, jpg, jpeg, webp
#
# Formato de salida: { "files": ["archivo1.png", "archivo2.gif", ...] }
# ============================================================

set -e

ALL_FOLDERS=("avatar_por_defecto" "avatar" "efecto_perfil" "emojis" "placa_nombre" "stickers")

# ── Función: limpiar manifests existentes ─────────────────
clean_manifests() {
    echo "── Limpiando manifests anteriores ──"
    for folder in "${ALL_FOLDERS[@]}"; do
        if [ -f "$folder/manifest.json" ]; then
            rm -f "$folder/manifest.json"
            echo "🗑️  Eliminado: $folder/manifest.json"
        fi
    done
    echo ""
}

# ── Función: manifest plano { "files": [...] } ─────────────
generate_flat_manifest() {
    local folder="$1"

    if [ ! -d "$folder" ]; then
        echo "⚠️  Carpeta '$folder' no encontrada, omitiendo."
        return
    fi

    local files=()
    while IFS= read -r -d '' file; do
        files+=("\"${file#$folder/}\"")
    done < <(find "$folder" -maxdepth 1 -type f \( \
        -iname "*.png" -o -iname "*.gif" -o \
        -iname "*.jpg" -o -iname "*.jpeg" -o \
        -iname "*.webp" \
    \) | sort -f | tr '\n' '\0')

    local timestamp
    timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    local json="{\n  \"generated\": \"$timestamp\",\n  \"files\": ["

    if [ ${#files[@]} -eq 0 ]; then
        json+="]\n}"
    else
        json+="\n    $(IFS=','; echo "${files[*]}" | sed 's/,/,\n    /g')\n  ]\n}"
    fi

    printf "%b" "$json" > "$folder/manifest.json"
    echo "✅ $folder/manifest.json → ${#files[@]} archivo(s)"
    for f in "${files[@]}"; do
        echo "   • $f"
    done
}

# ── Main ───────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo " Eclipse Zone — Generador de manifests"
echo "═══════════════════════════════════════"
echo ""

clean_manifests

echo "── Generando manifests ──"
for folder in "${ALL_FOLDERS[@]}"; do
    generate_flat_manifest "$folder"
    echo ""
done

echo "Listo. Commitea los manifest.json generados."
echo ""
echo "Estructura esperada:"
echo "  avatar_por_defecto/  → avatar1.png, avatar2.gif ..."
echo "  avatar/              → avatar1.png, avatar2.gif ..."
echo "  efecto_perfil/       → efecto1.webp, efecto2.gif ..."
echo "  emojis/              → emoji1.png, emoji2.gif ..."
echo "  placa_nombre/        → placa1.png, placa2.gif ..."
echo "  stickers/            → sticker1.png, sticker2.gif ..."
echo ""
echo "Formato de cada manifest.json:"
echo "  {"
echo "    \"generated\": \"2025-01-01T00:00:00Z\","
echo "    \"files\": [\"archivo1.png\", \"archivo2.gif\"]"
echo "  }"
echo ""
