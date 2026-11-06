"""Patch the pinned dxf-viewer 1.0.50 during the existing offline bundle build.

Only filled HATCH triangles are alpha blended. Patterned hatches, SOLID,
3DFACE, linework and the original DXF bytes are unchanged.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'tools/dxf-engine/node_modules/dxf-viewer/src'

def once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'DXF hatch renderer changed: {label} ({count} matches)')
    return text.replace(old, new, 1)

scene_path = ENGINE / 'DxfScene.js'
scene = scene_path.read_text()
start = scene.index('    *_DecomposeHatch(entity, blockCtx) {')
stop = scene.index('        let pattern = null', start)
solid = once(scene[start:stop], 'vertices, indices, layer, color',
             'vertices, indices, layer, color, isSolidHatch: true',
             'solid HATCH triangles')
scene = scene[:start] + solid + scene[stop:]
scene = once(scene, 'shape = false}) {',
             'shape = false, isSolidHatch = false}) {', 'entity constructor')
scene = once(scene, 'this.shape = shape',
             'this.shape = shape\n        this.isSolidHatch = isSolidHatch',
             'entity HATCH flag')
start = scene.index('    _ProcessTriangles(entity, blockCtx = null) {')
stop = scene.index('        const batch = this._GetBatch(key)', start)
region = once(scene[start:stop],
    'entity.color, 0)',
    'entity.color, entity.isSolidHatch ? -32000 : 0)',
    'separate solid HATCH batches')
scene = scene[:start] + region + scene[stop:]
scene_path.write_text(scene)

viewer_path = ENGINE / 'DxfViewer.js'
viewer = viewer_path.read_text()
viewer = once(viewer,
    'this.materials = new RBTree((m1, m2) => m1.key.Compare(m2.key))',
    'this.materials = new RBTree((m1, m2) => m1.key.Compare(m2.key))\n        this.hatchMaterials = new Map()\n        this.hatchOpacity = 0.5',
    'HATCH material lifecycle')
viewer = once(viewer,
    'this.blocks.clear()\n        this.materials.each(e => e.material.dispose())',
    'this.blocks.clear()\n        for (const material of this.hatchMaterials.values()) material.dispose()\n        this.hatchMaterials.clear()\n        this.materials.each(e => e.material.dispose())',
    'dispose HATCH materials')
viewer = once(viewer,
    'this.Render()\n    }\n\n    /** Reset the viewer state. */',
    '''this.Render()
    }

    /** Display-only opacity. Never writes to the source DXF. */
    SetHatchOpacity(value) {
        const next = Number(value)
        if (!Number.isFinite(next)) return
        this.hatchOpacity = Math.max(0.1, Math.min(1, next))
        for (const material of this.hatchMaterials.values()) {
            material.uniforms.hatchOpacity.value = this.hatchOpacity
            const transparent = this.hatchOpacity < 0.999
            if (material.transparent !== transparent) {
                material.transparent = transparent
                material.needsUpdate = true
            }
        }
        this.Render()
    }

    /** Reset the viewer state. */''',
    'opacity setter')
viewer = once(viewer,
    'entry.material.uniforms.color.value.setHex(this._TransformColor(entry.key.color)))\n\n        this.Render()',
    '''entry.material.uniforms.color.value.setHex(this._TransformColor(entry.key.color)))
        for (const [source, hatch] of this.hatchMaterials) {
            hatch.uniforms.color.value.copy(source.uniforms.color.value)
        }

        this.Render()''',
    'background color adjustment')
old_color = 'value: new three.Color(0xff00ff)\n                }'
if viewer.count(old_color) != 2:
    raise RuntimeError('DXF color uniforms changed')
viewer = viewer.replace(old_color,
    'value: new three.Color(0xff00ff)\n                },\n                hatchOpacity: {value: 1}')
viewer = once(viewer,
    'uniform vec3 color;\n            ${srgbConversion}',
    'uniform vec3 color;\n            uniform float hatchOpacity;\n            ${srgbConversion}',
    'fragment opacity uniform')
viewer = once(viewer,
    'fragColor = vec4(${fragmentColor}, 1.0);',
    'fragColor = vec4(${fragmentColor}, hatchOpacity);',
    'fragment alpha')
viewer = once(viewer,
    'const material = materialFactory.call(this.viewer, color,',
    'let material = materialFactory.call(this.viewer, color,',
    'mutable material for hatch-specific clone')
viewer = once(viewer,
    '        let objConstructor\n',
    '''        // Solid HATCH receives its own alpha material; other fills stay opaque.
        if (this.key.geometryType === BatchingKey.GeometryType.INDEXED_TRIANGLES &&
            this.key.lineType === -32000) {
            let hatchMaterial = this.viewer.hatchMaterials.get(material)
            if (!hatchMaterial) {
                hatchMaterial = material.clone()
                hatchMaterial.uniforms.hatchOpacity.value = this.viewer.hatchOpacity
                hatchMaterial.transparent = this.viewer.hatchOpacity < 0.999
                hatchMaterial.depthWrite = false
                this.viewer.hatchMaterials.set(material, hatchMaterial)
            }
            material = hatchMaterial
        }

        let objConstructor
''',
    'isolated HATCH material')
viewer_path.write_text(viewer)
print('DXF: solid HATCH opacity separated from patterns/linework; original CAD preserved')
