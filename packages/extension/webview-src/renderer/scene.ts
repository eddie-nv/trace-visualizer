const SVG_NS = "http://www.w3.org/2000/svg";

export interface SceneLayers {
  readonly svg: SVGSVGElement;
  readonly fragments: SVGGElement;
  readonly lifelines: SVGGElement;
  readonly arrows: SVGGElement;
  readonly nodes: SVGGElement;
}

interface ZoomState {
  tx: number;
  ty: number;
  scale: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;

export function createScene(container: HTMLElement): SceneLayers {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.display = "block";
  svg.style.background = "var(--tv-bg)";

  const defs = document.createElementNS(SVG_NS, "defs");
  defs.innerHTML = `
    <marker id="ag-arrow-solid" markerWidth="8" markerHeight="8"
            refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L8,3 z" fill="var(--tv-arrow-solid)"/>
    </marker>
    <marker id="ag-arrow-dashed" markerWidth="8" markerHeight="8"
            refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L6,3 L0,6" fill="none" stroke="var(--tv-arrow-dashed)" stroke-width="1"/>
    </marker>
  `;
  svg.appendChild(defs);

  const zoomGroup = document.createElementNS(SVG_NS, "g") as SVGGElement;
  zoomGroup.setAttribute("class", "ag-zoom-group");

  const fragmentsG = document.createElementNS(SVG_NS, "g") as SVGGElement;
  fragmentsG.setAttribute("class", "ag-fragments");
  const lifelinesG = document.createElementNS(SVG_NS, "g") as SVGGElement;
  lifelinesG.setAttribute("class", "ag-lifelines");
  const arrowsG = document.createElementNS(SVG_NS, "g") as SVGGElement;
  arrowsG.setAttribute("class", "ag-arrows");
  const nodesG = document.createElementNS(SVG_NS, "g") as SVGGElement;
  nodesG.setAttribute("class", "ag-nodes");

  zoomGroup.appendChild(fragmentsG);
  zoomGroup.appendChild(lifelinesG);
  zoomGroup.appendChild(arrowsG);
  zoomGroup.appendChild(nodesG);
  svg.appendChild(zoomGroup);

  container.appendChild(svg);

  const zoom: ZoomState = { tx: 0, ty: 0, scale: 1 };

  function applyZoom(): void {
    zoomGroup.setAttribute(
      "transform",
      `translate(${zoom.tx},${zoom.ty}) scale(${zoom.scale})`,
    );
  }

  svg.addEventListener("wheel", (e: WheelEvent) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, zoom.scale * zoomFactor));
    const ratio = newScale / zoom.scale;

    zoom.tx = mouseX - ratio * (mouseX - zoom.tx);
    zoom.ty = mouseY - ratio * (mouseY - zoom.ty);
    zoom.scale = newScale;
    applyZoom();
  }, { passive: false });

  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panStartTx = 0;
  let panStartTy = 0;

  svg.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.target !== svg && e.target !== zoomGroup) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartTx = zoom.tx;
    panStartTy = zoom.ty;
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener("pointermove", (e: PointerEvent) => {
    if (!isPanning) return;
    zoom.tx = panStartTx + (e.clientX - panStartX);
    zoom.ty = panStartTy + (e.clientY - panStartY);
    applyZoom();
  });

  svg.addEventListener("pointerup", () => {
    isPanning = false;
  });

  return { svg, fragments: fragmentsG, lifelines: lifelinesG, arrows: arrowsG, nodes: nodesG };
}
