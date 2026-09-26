// Bounded deterministic layout: no timers or continuous physics while the app is idle.
export function layoutNetwork(nodes, edges, saved = new Map()) {
    const points = nodes.map((node, i) => ({ id: node.id, x: Math.cos(i * 2.39996) * Math.sqrt(i + 1) * 90, y: Math.sin(i * 2.39996) * Math.sqrt(i + 1) * 75 }));
    const lookup = new Map(points.map(p => [p.id, p]));
    const pairs = [...new Set(edges.map(e => [e.fromId,e.toId].sort().join('\0'))) ].map(key => key.split('\0').map(id => lookup.get(id))).filter(p => p[0] && p[1] && p[0] !== p[1]);
    for (let step = 0; step < 160; step++) {
        const forces = points.map(() => ({x:0,y:0}));
        for (let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++) {
            const a=points[i], b=points[j], dx=a.x-b.x,dy=a.y-b.y,d=Math.max(1,Math.hypot(dx,dy));
            const f=Math.min(8,5000/(d*d)); forces[i].x+=dx/d*f;forces[i].y+=dy/d*f;forces[j].x-=dx/d*f;forces[j].y-=dy/d*f;
        }
        points.forEach((p,i)=>{p.x+=forces[i].x*.6;p.y+=forces[i].y*.6;});
        for(const [a,b] of pairs){const dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),f=(d-145)*.018;a.x+=dx/d*f;a.y+=dy/d*f;b.x-=dx/d*f;b.y-=dy/d*f;}
        // Separate name label boxes as well as the small circles.
        for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
            const a=points[i],b=points[j],dx=b.x-a.x,dy=b.y-a.y;
            if(Math.abs(dx)<116 && Math.abs(dy)<82){if(116-Math.abs(dx)<82-Math.abs(dy)){const shift=(116-Math.abs(dx))/2+.1,sign=dx>=0?1:-1;a.x-=shift*sign;b.x+=shift*sign;}else{const shift=(82-Math.abs(dy))/2+.1,sign=dy>=0?1:-1;a.y-=shift*sign;b.y+=shift*sign;}}
        }
    }
    // Resolve residual crowding after the bounded relaxation without an idle simulation.
    const placed=[];
    for(const p of points){const ox=p.x,oy=p.y;let attempt=0;
        while(placed.some(q=>Math.abs(q.x-p.x)<116 && Math.abs(q.y-p.y)<82)){
            attempt++;const angle=attempt*2.39996,r=22*Math.sqrt(attempt);p.x=ox+Math.cos(angle)*r;p.y=oy+Math.sin(angle)*r;
        }
        placed.push(p);
    }
    const minX=Math.min(0,...points.map(p=>p.x)),minY=Math.min(0,...points.map(p=>p.y));
    points.forEach(p=>{p.x+=75-minX;p.y+=50-minY;const stored=saved.get(p.id);if(stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)){p.x=Math.max(30,stored.x);p.y=Math.max(30,stored.y);}});
    return {points,width:Math.max(340,...points.map(p=>p.x+75)),height:Math.max(260,...points.map(p=>p.y+70))};
}
export function networkPath(from,to,bend=0){
    const dx=to.x-from.x,dy=to.y-from.y,d=Math.max(1,Math.hypot(dx,dy));
    return `M ${from.x+dx/d*14} ${from.y+dy/d*14} Q ${(from.x+to.x)/2-dy/d*bend} ${(from.y+to.y)/2+dx/d*bend} ${to.x-dx/d*20} ${to.y-dy/d*20}`;
}
