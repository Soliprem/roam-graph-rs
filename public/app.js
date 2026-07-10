const canvas = document.querySelector("#graph");
const ctx = canvas.getContext("2d");
const searchInput = document.querySelector("#search");
const showTagsInput = document.querySelector("#showTags");
const hideOrphansInput = document.querySelector("#hideOrphans");
const showLabelsInput = document.querySelector("#showLabels");
const darkModeInput = document.querySelector("#darkMode");
const gravityInput = document.querySelector("#gravity");
const hubPullInput = document.querySelector("#hubPull");
const repulsionInput = document.querySelector("#repulsion");
const linkStrengthInput = document.querySelector("#linkStrength");
const inertiaInput = document.querySelector("#inertia");
const textSizeInput = document.querySelector("#textSize");
const secondaryLabelsInput = document.querySelector("#secondaryLabels");
const gravityValue = document.querySelector("#gravityValue");
const repulsionValue = document.querySelector("#repulsionValue");
const linkStrengthValue = document.querySelector("#linkStrengthValue");
const inertiaValue = document.querySelector("#inertiaValue");
const textSizeValue = document.querySelector("#textSizeValue");
const secondaryLabelValue = document.querySelector("#secondaryLabelValue");
const statsEl = document.querySelector("#stats");
const detailsEl = document.querySelector("#details");
const notebookEl = document.querySelector("#notebook");
const hideSidebarButton = document.querySelector("#hideSidebar");
const showSidebarButton = document.querySelector("#showSidebar");

let graph = { nodes: [], edges: [] };
let visibleNodes = [];
let visibleEdges = [];
let nodeById = new Map();
let selected = null;
let hovered = null;
let draggingNode = null;
let draggingNodeWasFixed = false;
let panning = false;
let pointerMoved = false;
let lastPointer = { x: 0, y: 0 };
let transform = { x: 0, y: 0, scale: 1 };
let running = true;
let energy = 1;
let simulationTicks = 0;
let calmTicks = 0;

function wake(amount = 1) {
  energy = Math.max(energy, amount);
  simulationTicks = 0;
  calmTicks = 0;
  running = true;
}

function updateControlLabels() {
  gravityValue.textContent = gravityInput.value;
  repulsionValue.textContent = repulsionInput.value;
  linkStrengthValue.textContent = linkStrengthInput.value;
  inertiaValue.textContent = (Number(inertiaInput.value) / 1000).toFixed(3);
  textSizeValue.textContent = textSizeInput.value;
  secondaryLabelValue.textContent = secondaryLabelsInput.value;
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function worldFromScreen(x, y) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (x - rect.left - transform.x) / transform.scale,
    y: (y - rect.top - transform.y) / transform.scale,
  };
}

function screenFromWorld(x, y) {
  return {
    x: x * transform.scale + transform.x,
    y: y * transform.scale + transform.y,
  };
}

function nodeRadius(node) {
  if (node.group === "tag") return 8 + Math.min(5, Math.sqrt(node.degree || 1));
  return 6 + Math.min(12, Math.sqrt(node.degree || 1) * 1.8);
}

function nodeFontSize(node) {
  const base = Number(textSizeInput.value);
  if (node.group === "tag") return base;
  const degreeBoost = Math.min(10, Math.sqrt(node.degree || 0) * 2.2);
  const wordBoost = Math.min(5, Math.log10(Math.max(1, node.wordCount || 1)) * 2);
  return base + degreeBoost + wordBoost;
}

function readableWorldSize(worldSize, minScreenSize, maxMultiplier) {
  const minWorldSize = minScreenSize / transform.scale;
  return Math.min(worldSize * maxMultiplier, Math.max(worldSize, minWorldSize));
}

function visualNodeRadius(node) {
  return readableWorldSize(nodeRadius(node), node.group === "tag" ? 5 : 6, 2.2);
}

function selectedEdge(edge) {
  return selected && (edge.from === selected.id || edge.to === selected.id);
}

function hoveredEdge(edge) {
  return hovered && (edge.from === hovered.id || edge.to === hovered.id);
}

function highlightedEdge(edge) {
  return selectedEdge(edge) || hoveredEdge(edge);
}

function selectedNeighbor(node) {
  return (
    selected &&
    node !== selected &&
    visibleEdges.some(
      (edge) =>
        selectedEdge(edge) &&
        (edge.from === node.id || edge.to === node.id),
    )
  );
}

function labelVisible(node) {
  if (node === selected || node === hovered || selectedNeighbor(node)) return true;
  const threshold = Number(secondaryLabelsInput.value) / 100;
  const importance = Math.min(1, (node.degree || 0) / 8 + Math.log10(Math.max(1, node.wordCount || 1)) / 8);
  const zoomVisibility = Math.min(1, Math.max(0, (transform.scale - 0.16) / 0.85));
  return importance * 0.65 + zoomVisibility * 0.35 >= threshold;
}

function initPositions() {
  const count = graph.nodes.length || 1;
  graph.nodes.forEach((node) => {
    node.vx = 0;
    node.vy = 0;
    node.degree = 0;
    node.noteDegree = 0;
  });
  graph.edges.forEach((edge) => {
    nodeById.get(edge.from).degree += 1;
    nodeById.get(edge.to).degree += 1;
    if (edge.kind === "link") {
      nodeById.get(edge.from).noteDegree += 1;
      nodeById.get(edge.to).noteDegree += 1;
    }
  });
  const mainRadius = 80 + Math.sqrt(count) * 22;
  const orphanRadius = mainRadius + 110 + Math.sqrt(count) * 8;
  const orphans = graph.nodes.filter((node) => node.group === "note" && (node.noteDegree || 0) === 0);
  let orphanIndex = 0;

  graph.nodes.forEach((node, index) => {
    const orphan = node.group === "note" && (node.noteDegree || 0) === 0;
    const ringCount = orphan ? Math.max(1, orphans.length) : count;
    const ringIndex = orphan ? orphanIndex++ : index;
    const angle = (ringIndex / ringCount) * Math.PI * 2;
    const radius = orphan ? orphanRadius : mainRadius;
    const jitter = orphan ? 28 : 80;
    node.x = Math.cos(angle) * radius + (Math.random() - 0.5) * jitter;
    node.y = Math.sin(angle) * radius + (Math.random() - 0.5) * jitter;
  });
}

function applyFilters() {
  const query = searchInput.value.trim().toLowerCase();
  const showTags = showTagsInput.checked;
  const hideOrphans = hideOrphansInput.checked;
  const include = new Set();

  for (const node of graph.nodes) {
    if (!showTags && node.group === "tag") continue;
    if (hideOrphans && node.group === "note" && (node.noteDegree || 0) === 0) continue;
    if (!query || node.label.toLowerCase().includes(query) || node.path?.toLowerCase().includes(query)) {
      include.add(node.id);
    }
  }

  if (query) {
    for (const edge of graph.edges) {
      if (include.has(edge.from) || include.has(edge.to)) {
        if (showTags || nodeById.get(edge.from)?.group !== "tag") include.add(edge.from);
        if (showTags || nodeById.get(edge.to)?.group !== "tag") include.add(edge.to);
      }
    }
  }

  visibleNodes = graph.nodes.filter((node) => include.has(node.id));
  visibleEdges = graph.edges.filter((edge) => include.has(edge.from) && include.has(edge.to));
  selected = selected && include.has(selected.id) ? selected : null;
}

function tick() {
  if (!running) return;
  const nodes = visibleNodes;
  const edges = visibleEdges;
  const alpha = Math.max(0, Math.min(1, energy));
  const gravity = Number(gravityInput.value) / 100;
  const hubPull = hubPullInput.checked;
  const repulsion = Number(repulsionInput.value) / 100;
  const linkStrength = Number(linkStrengthInput.value) / 100;
  const energyRetention = Number(inertiaInput.value) / 1000;
  const gravityForce = (gravity * gravity * 0.0105 + gravity * 0.0015) * alpha;
  const repulsionForce = (0.08 + repulsion * repulsion * 0.92) * alpha;
  const linkStrengthForce = 0.002 + linkStrength * 0.017142857;
  const linkDistance = 90;
  simulationTicks += 1;

  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    if (a.fixed) continue;
    const gravityWeight = hubPull ? Math.min(2.5, 1 + Math.sqrt(a.degree || 0) * 0.12) : 1;
    a.vx += -a.x * gravityForce * gravityWeight;
    a.vy += -a.y * gravityForce * gravityWeight;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      const dx = b.x - a.x || 0.01;
      const dy = b.y - a.y || 0.01;
      const distance2 = dx * dx + dy * dy;
      if (distance2 > 360000) continue;
      const distance = Math.sqrt(distance2);
      const force = Math.min(1200 / distance2, 0.09) * repulsionForce;
      const fx = dx * force;
      const fy = dy * force;
      if (!a.fixed) {
        a.vx -= fx;
        a.vy -= fy;
      }
      if (!b.fixed) {
        b.vx += fx;
        b.vy += fy;
      }
      const minDistance = nodeRadius(a) + nodeRadius(b) + 8;
      if (distance < minDistance) {
        const collisionForce = ((minDistance - distance) / minDistance) * 0.18 * alpha;
        const cx = (dx / distance) * collisionForce;
        const cy = (dy / distance) * collisionForce;
        if (!a.fixed) {
          a.vx -= cx;
          a.vy -= cy;
        }
        if (!b.fixed) {
          b.vx += cx;
          b.vy += cy;
        }
      }
    }
  }

  for (const edge of edges) {
    const a = nodeById.get(edge.from);
    const b = nodeById.get(edge.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy) || 1;
    const desired = edge.kind === "tag" ? 70 : linkDistance;
    const force = (distance - desired) * linkStrengthForce * alpha;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    if (!a.fixed) {
      a.vx += fx;
      a.vy += fy;
    }
    if (!b.fixed) {
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  let motion = 0;
  for (const node of nodes) {
    if (node.fixed) continue;
    node.vx = Math.max(-12, Math.min(12, node.vx * 0.82));
    node.vy = Math.max(-12, Math.min(12, node.vy * 0.82));
    if (Math.abs(node.vx) < 0.01) node.vx = 0;
    if (Math.abs(node.vy) < 0.01) node.vy = 0;
    node.x += node.vx;
    node.y += node.vy;
    motion += Math.abs(node.vx) + Math.abs(node.vy);
  }

  energy *= energyRetention;
  if (motion / Math.max(1, nodes.length) < 0.006) calmTicks += 1;
  else calmTicks = 0;

  if (energy < 0.006 || simulationTicks > 1800 || calmTicks > 90) {
    for (const node of nodes) {
      node.vx = 0;
      node.vy = 0;
    }
    running = false;
  }
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  const styles = getComputedStyle(document.body);
  const textColor = styles.getPropertyValue("--text").trim();
  const mutedColor = styles.getPropertyValue("--muted").trim();
  const noteFill = styles.getPropertyValue("--note").trim();
  const noteBorder = styles.getPropertyValue("--note-border").trim();
  const tagFill = styles.getPropertyValue("--tag").trim();
  const tagBorder = styles.getPropertyValue("--tag-border").trim();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.scale, transform.scale);

  for (const edge of visibleEdges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) continue;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    const active = highlightedEdge(edge);
    ctx.strokeStyle = active
      ? edge.kind === "tag"
        ? tagBorder
        : "#f09a54"
      : edge.kind === "tag"
        ? darkModeInput.checked
          ? "rgba(108,179,202,0.42)"
          : "rgba(55,117,143,0.5)"
        : darkModeInput.checked
          ? "rgba(190,180,150,0.34)"
          : "rgba(76,72,66,0.42)";
    ctx.lineWidth = active ? 4.5 : edge.kind === "tag" ? 1.7 : 1.8;
    ctx.setLineDash(edge.kind === "tag" ? [4, 5] : []);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const node of visibleNodes) {
    const radius = visualNodeRadius(node);
    const isSelected = selected === node;
    const isHovered = hovered === node;
    const isNeighbor = selectedNeighbor(node);
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius + (isSelected ? 5 : isHovered || isNeighbor ? 2 : 0), 0, Math.PI * 2);
    ctx.fillStyle =
      node.group === "tag"
        ? isSelected
          ? "#74b3c7"
          : tagFill
        : isSelected
          ? "#d7b56d"
          : noteFill;
    ctx.fill();
    ctx.strokeStyle = node.group === "tag" ? tagBorder : noteBorder;
    ctx.lineWidth = readableWorldSize(
      isSelected || isNeighbor ? 3.2 : 1.6,
      isSelected || isNeighbor ? 1.6 : 0.9,
      2.2,
    );
    ctx.stroke();
  }

  if (showLabelsInput.checked) {
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const node of visibleNodes) {
      if (!labelVisible(node)) continue;
      const maxChars = node === selected || selectedNeighbor(node) ? 54 : 38;
      const label = node.label.length > maxChars ? `${node.label.slice(0, maxChars - 3)}...` : node.label;
      const size = nodeFontSize(node);
      ctx.font = `${size}px system-ui, sans-serif`;
      ctx.lineWidth = Math.max(5, size * 0.36);
      ctx.strokeStyle = darkModeInput.checked ? "rgba(12,13,11,0.96)" : "rgba(246,245,240,0.96)";
      ctx.strokeText(label, node.x, node.y + nodeRadius(node) + 6);
      ctx.fillStyle = selectedNeighbor(node) || node === selected || node.degree > 3 ? textColor : mutedColor;
      ctx.fillText(label, node.x, node.y + nodeRadius(node) + 6);
    }
  }

  ctx.restore();
}

function animate() {
  tick();
  draw();
  requestAnimationFrame(animate);
}

function hitTest(event) {
  const point = worldFromScreen(event.clientX, event.clientY);
  let best = null;
  let bestDistance = Infinity;
  for (const node of visibleNodes) {
    const distance = Math.hypot(point.x - node.x, point.y - node.y);
    if (distance < nodeRadius(node) + 8 && distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

function updateDetails(node) {
  if (!node) {
    detailsEl.innerHTML = "<h2>Selection</h2><p>Click a node to inspect it. Drag nodes to move them. Double-click nodes to pin or release them.</p>";
    return;
  }
  const links = visibleEdges.filter((edge) => edge.from === node.id || edge.to === node.id);
  detailsEl.innerHTML = `
    <h2>${escapeHtml(node.label)}</h2>
    <dl>
      <dt>Type</dt><dd>${node.group}</dd>
      ${node.path ? `<dt>Path</dt><dd>${escapeHtml(node.path)}</dd>` : ""}
      ${node.absPath ? `<dt>Absolute</dt><dd>${escapeHtml(node.absPath)}</dd>` : ""}
      <dt>Visible links</dt><dd>${links.length}</dd>
      ${node.wordCount ? `<dt>Words</dt><dd>${node.wordCount}</dd>` : ""}
    </dl>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function updateStats(data) {
  statsEl.innerHTML = `
    <div class="stat"><strong>${data.stats.notes}</strong> notes</div>
    <div class="stat"><strong>${data.stats.tags}</strong> tags</div>
    <div class="stat"><strong>${data.stats.noteLinks}</strong> note links</div>
    <div class="stat"><strong>${data.stats.tagLinks}</strong> tag links</div>
  `;
}

function fitGraph() {
  if (!visibleNodes.length) return;
  const rect = canvas.getBoundingClientRect();
  const xs = visibleNodes.map((node) => node.x);
  const ys = visibleNodes.map((node) => node.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const graphWidth = Math.max(1, maxX - minX);
  const graphHeight = Math.max(1, maxY - minY);
  const scale = Math.min(rect.width / graphWidth, rect.height / graphHeight) * 0.82;
  transform.scale = Math.max(0.08, Math.min(2.5, scale));
  transform.x = rect.width / 2 - ((minX + maxX) / 2) * transform.scale;
  transform.y = rect.height / 2 - ((minY + maxY) / 2) * transform.scale;
}

async function loadGraph() {
  running = false;
  const response = await fetch("/api/graph");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to load graph");
  graph = data;
  nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  initPositions();
  applyFilters();
  updateStats(data);
  notebookEl.textContent = data.notebook;
  updateDetails(null);
  wake(1);
  setTimeout(fitGraph, 350);
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  pointerMoved = false;
  lastPointer = { x: event.clientX, y: event.clientY };
  draggingNode = hitTest(event);
  if (draggingNode) {
    selected = draggingNode;
    draggingNodeWasFixed = draggingNode.fixed;
    draggingNode.fixed = true;
    draggingNode.vx = 0;
    draggingNode.vy = 0;
    updateDetails(selected);
    wake(0.85);
  } else {
    panning = true;
  }
  canvas.classList.add("dragging");
});

canvas.addEventListener("pointermove", (event) => {
  if (Math.hypot(event.clientX - lastPointer.x, event.clientY - lastPointer.y) > 2) pointerMoved = true;
  hovered = hitTest(event);
  if (draggingNode) {
    const point = worldFromScreen(event.clientX, event.clientY);
    draggingNode.x = point.x;
    draggingNode.y = point.y;
    draggingNode.vx = 0;
    draggingNode.vy = 0;
    wake(1);
  } else if (panning) {
    transform.x += event.clientX - lastPointer.x;
    transform.y += event.clientY - lastPointer.y;
  }
  lastPointer = { x: event.clientX, y: event.clientY };
});

canvas.addEventListener("pointerup", () => {
  if (!pointerMoved && !draggingNode) {
    selected = null;
    updateDetails(null);
  }
  if (draggingNode) {
    draggingNode.fixed = draggingNodeWasFixed;
  }
  draggingNode = null;
  draggingNodeWasFixed = false;
  panning = false;
  canvas.classList.remove("dragging");
});

canvas.addEventListener("dblclick", (event) => {
  const node = hitTest(event);
  if (node) {
    node.fixed = !node.fixed;
    node.vx = 0;
    node.vy = 0;
    wake(0.7);
  }
});

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const local = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const before = worldFromScreen(event.clientX, event.clientY);
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    transform.scale = Math.max(0.05, Math.min(4, transform.scale * factor));
    const after = screenFromWorld(before.x, before.y);
    transform.x += local.x - after.x;
    transform.y += local.y - after.y;
  },
  { passive: false },
);

searchInput.addEventListener("input", () => {
  applyFilters();
  fitGraph();
  wake(0.8);
});
showTagsInput.addEventListener("change", () => {
  applyFilters();
  fitGraph();
  wake(0.8);
});
hideOrphansInput.addEventListener("change", () => {
  applyFilters();
  fitGraph();
  wake(0.8);
});
showLabelsInput.addEventListener("change", draw);
darkModeInput.addEventListener("change", () => {
  document.body.classList.toggle("dark", darkModeInput.checked);
  localStorage.setItem("roamGraphDarkMode", darkModeInput.checked ? "1" : "0");
  draw();
});
gravityInput.addEventListener("input", () => {
  updateControlLabels();
  wake(0.25);
});
hubPullInput.addEventListener("change", () => {
  wake(0.45);
});
repulsionInput.addEventListener("input", () => {
  updateControlLabels();
  wake(0.25);
});
linkStrengthInput.addEventListener("input", () => {
  updateControlLabels();
  wake(0.25);
});
inertiaInput.addEventListener("input", () => {
  updateControlLabels();
  wake(0.25);
});
textSizeInput.addEventListener("input", () => {
  updateControlLabels();
  draw();
});
secondaryLabelsInput.addEventListener("input", () => {
  updateControlLabels();
  draw();
});
document.querySelector("#fit").addEventListener("click", fitGraph);
document.querySelector("#reload").addEventListener("click", loadGraph);
hideSidebarButton.addEventListener("click", () => {
  document.body.classList.add("sidebar-hidden");
  requestAnimationFrame(() => {
    resize();
    fitGraph();
  });
});
showSidebarButton.addEventListener("click", () => {
  document.body.classList.remove("sidebar-hidden");
  requestAnimationFrame(() => {
    resize();
    fitGraph();
  });
});

window.addEventListener("resize", () => {
  resize();
  fitGraph();
  draw();
});

darkModeInput.checked = localStorage.getItem("roamGraphDarkMode") === "1";
document.body.classList.toggle("dark", darkModeInput.checked);
updateControlLabels();
resize();
loadGraph().catch((error) => {
  detailsEl.innerHTML = `<h2>Error</h2><p>${escapeHtml(error.message)}</p>`;
});
animate();
