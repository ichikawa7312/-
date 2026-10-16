/* Sentlog v1.54: connect annotation labels, leaders and tips with family colors.
 * Only tagged display nodes are painted. No record, layout or input writes.
 * SVG paint-order draws the white outline behind the colored glyphs.
 */
(function(root){
 'use strict';
 const BLACK='#111827',WHITE='#FFFFFF';
 const validColor=c=>typeof c==='string'&&/^#[0-9a-f]{6}$/i.test(c);
 const zoom=z=>Number.isFinite(z)&&z>0?Math.max(.001,z):1;
 function labelStyle(name,project,mode='hatch',scale=1){
  const st=root.SentlogDamageStyles?.styleFor(name,project,mode);
  const color=(mode==='hatch'||mode==='color')&&validColor(st?.color)?st.color:BLACK;
  return {color,halo:2.2/zoom(scale)};
 }
 function paintNodes(host,records,project,mode,scale){
  const shapes=new Map(records.map(s=>[s.id,s])),styles=new Map();
  for(const node of host.querySelectorAll('[data-damage-label-id]')){
   const shape=shapes.get(node.dataset.damageLabelId);
   if(!shape)continue;
   if(!styles.has(shape.type))styles.set(shape.type,labelStyle(shape.type,project,mode,scale));
   const st=styles.get(shape.type),role=node.dataset.damageLabelRole;
   if(role==='name'&&node.localName==='text'){
    node.setAttribute('fill',st.color);
    node.setAttribute('stroke',WHITE);
    node.setAttribute('stroke-width',String(st.halo));
    node.setAttribute('stroke-linejoin','round');
    node.setAttribute('paint-order','stroke fill');
   }else if(role==='leader'&&node.localName==='line'){
    // Preserve 0.6px screen width, coordinates and the original solid line.
    node.setAttribute('stroke',st.color);
   }else if(role==='marker'){
    const kind=node.dataset.damageMarkerKind;
    if(kind==='open-circle'&&node.localName==='circle'){
     node.setAttribute('fill',WHITE);node.setAttribute('stroke',st.color);
    }else if(kind==='filled-circle'&&node.localName==='circle'){
     node.setAttribute('fill',st.color);node.setAttribute('stroke',WHITE);
    }else if(kind==='arrow'&&node.localName==='polygon'){
     node.setAttribute('fill',st.color);node.setAttribute('stroke',st.color);
    }
   }
  }
 }
 const api={labelStyle,paintNodes};root.SentlogLabelColors=api;
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(typeof document==='undefined'||!document.getElementById('svg'))return;
 if(!root.SentlogDamageStyles)throw Error('変状の色・模様が未読込です。');
 function paint(){paintNodes(svg,currentShapes(),getProject(),root.SentlogDamageStyles.getMode(),scale);}
 const oldRender=render;
 render=function(){const result=oldRender.apply(this,arguments);paint();return result;};
 api.paint=paint;
 if(currentView==='editor')render();
})(typeof window==='object'?window:globalThis);
