// Minifica js/*.js y css/*.css IN-PLACE.
// Correr a mano cada vez que se edite algo en js/ o css/ (no está integrado
// al build de generate-everything.js: js/ y css/ son la fuente minificada
// directamente, no hay una copia legible aparte — minificar en cada build
// sería minificar algo ya minificado, sin beneficio, y complicaría debugging).
//
// Uso: node scripts/minify.js
//
// mangle:false en terser es deliberado — los .js del sitio son scripts
// clásicos (no módulos) que comparten scope global entre sí en secuencia;
// mangle podría renombrar algo que otro archivo referencia y que terser no
// puede ver al procesar cada archivo por separado.
const { minify } = require('terser');
const CleanCSS = require('clean-css');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

(async () => {
    let totalJsOrig = 0, totalJsMin = 0, jsErrors = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'))) {
        const filePath = path.join(ROOT, 'js', f);
        const src = fs.readFileSync(filePath, 'utf8');
        totalJsOrig += src.length;
        try {
            const result = await minify(src, { mangle: false, compress: { sequences: true }, format: { comments: false } });
            if (!result.code) throw new Error('empty output');
            totalJsMin += result.code.length;
            fs.writeFileSync(filePath, result.code, 'utf8');
        } catch (e) {
            jsErrors.push(`${f}: ${e.message}`);
            totalJsMin += src.length;
        }
    }

    let totalCssOrig = 0, totalCssMin = 0, cssErrors = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css'))) {
        const filePath = path.join(ROOT, 'css', f);
        const src = fs.readFileSync(filePath, 'utf8');
        totalCssOrig += src.length;
        try {
            const result = new CleanCSS({ level: 1 }).minify(src);
            if (result.errors.length) throw new Error(result.errors.join('; '));
            totalCssMin += result.styles.length;
            fs.writeFileSync(filePath, result.styles, 'utf8');
        } catch (e) {
            cssErrors.push(`${f}: ${e.message}`);
            totalCssMin += src.length;
        }
    }

    console.log('JS:  ', (totalJsOrig / 1024).toFixed(1), 'KiB ->', (totalJsMin / 1024).toFixed(1), 'KiB', '(-' + (100 - (totalJsMin / totalJsOrig) * 100).toFixed(1) + '%)');
    console.log('CSS: ', (totalCssOrig / 1024).toFixed(1), 'KiB ->', (totalCssMin / 1024).toFixed(1), 'KiB', '(-' + (100 - (totalCssMin / totalCssOrig) * 100).toFixed(1) + '%)');
    if (jsErrors.length) console.log('JS ERRORS:', jsErrors);
    if (cssErrors.length) console.log('CSS ERRORS:', cssErrors);
    console.log('\nRecordá: reconstruir (node generate-everything.js --no-cache), verificar visualmente y desplegar después de correr esto.');
})();
