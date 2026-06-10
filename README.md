# FRONTLINES — fictional war simulator

A zero-dependency browser game. A fictional world map is procedurally generated;
you click nations onto two opposing alliances and declare war — then you just watch.
The war fights itself in real time, with speed controls.

## Run it

Open `index.html` in any modern browser (or serve the folder with any static server):

```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

## How to play

1. **New World** generates a random map of nations (each world has a seed).
2. Click nations to cycle their allegiance: **Crimson Pact → Azure League → neutral**.
   You only pick the sides — you never command anything.
3. **Declare War**. Divisions mobilize, march to the shared borders, and fight.
4. Use the time controls (pause, ½×–8×) to watch the front buckle in real time.
5. Wars end on their own: capitulation (too much territory lost), collapse
   (armies annihilated), or armistice (stalemate). The new borders stick —
   you can immediately set up the next war on the redrawn map.

## The border guarantee

The central design constraint: **a border is one persistent object.**

- At world generation, every border between two nations is extracted once as a
  polyline of shared vertex objects. Country territory polygons reference those
  *same* vertex objects.
- Before a war the border object is perfectly still.
- During a war it is not replaced by any effect or overlay — the simulation
  pushes the *existing* border's vertices around as divisions mass, clash and
  push along it, so the line itself trembles and bends, and the nations'
  territories deform with it (they share the vertices).
- After the peace, the very same object simply stops moving, frozen along the
  final front line.

This is verified by automated tests (`node test/headless.js`), which assert
referential identity of border objects and their vertices before, during and
after a full simulated war.

## Simulation model

- **Map**: jittered-grid mesh, fBm-noise continents, randomized multi-source
  Dijkstra growth for nations, runt-state merging, lakes and islands.
- **Divisions**: spawn from each nation's manpower pool, deploy to front
  vertices, redeploy toward weak points, and project gaussian influence onto
  nearby border vertices.
- **The front**: each border vertex is pushed by the local balance of forces
  (with combat tremble when contested), the displacement field is blurred along
  the line so neighbouring sectors move together, folds are relaxed, segment
  stretch is constrained, and vertices are confined to the two warring nations.
- **Attrition**: engaged divisions take casualties; exhausted nations stop
  reinforcing; losing too much territory triggers capitulation.

## Files

- `index.html`, `style.css` — UI shell
- `main.js` — world generation, simulation and rendering (no dependencies)
- `test/headless.js` — node-based simulation tests
