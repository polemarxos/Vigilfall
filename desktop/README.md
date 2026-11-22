# Vigilfall for Windows

A window around the online game (`https://polemarxos.github.io/Vigilfall/`), so it always runs the newest version.

Build (Linux): `npm i -D electron electron-builder`, `npx electron-builder --win dir --x64` (makes `dist/win-unpacked`),
delete `dxcompiler.dll`/`dxil.dll` (WebGPU only, keeps the installer under GitHub's 100 MB), then `makensis installer.nsi`
→ `dist/Vigilfall-Setup.exe`, copied to the repo root (served by GitHub Pages next to `index.html`).
