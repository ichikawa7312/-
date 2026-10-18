# DXF display engine

Generated bundles use dxf-viewer 1.0.50 (MPL-2.0) and its locked dependencies.
Entry points and the exact dependency lock are provided in this directory.
The CFF glyph bounds patch is documented below. Original source distribution:
https://registry.npmjs.org/dxf-viewer/-/dxf-viewer-1.0.50.tgz
https://github.com/vagran/dxf-viewer

Three.js, opentype.js, loglevel and earcut carry their respective MIT/BSD licenses.
The build copies dependency license texts into sentlog/vendor/dxf-licenses.txt.

Noto Sans CJK JP is redistributed as a subset in WOFF format under SIL OFL 1.1.
Its license is included in the generated vendor directory. It is a display font
substitution; original DXF text styles and font references are not rewritten.
https://github.com/notofonts/noto-cjk

Sentlog modifies dxf-viewer TextRenderer.js to calculate CFF/OpenType glyph
bounds from their outlines. The exact MPL-2.0 source is published beside the
bundles at `vendor/dxf-text-renderer-source.js`. The reproducible patch is in
`scripts/build_dxf.py`. Other upstream sources are from dxf-viewer 1.0.50.
