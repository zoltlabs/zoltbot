// Pointer and keyboard control of the map: pan, zoom, hover, click and box select.
//   drag with the left button     box select (Shift adds to the selection)
//   click a unit                  open its chat (Shift+click selects it instead)
//   drag with another button, or one finger on a touch screen: pan
//   wheel or two-finger scroll    pan; with Ctrl or Cmd, zoom
//   arrow keys, + and -, 0        pan, zoom, show the whole map
(() => {
  const map = window.CommandMap;
  map.Input = class {
    constructor(scene) {
      const canvas = scene.canvas,
        box = document.querySelector("#box"),
        camera = scene.camera;
      let start;
      const end = () => {
        start = undefined;
        box.hidden = true;
        scene.interacting = false;
      };
      canvas.oncontextmenu = (event) => event.preventDefault();
      canvas.onpointerdown = (event) => {
        canvas.setPointerCapture(event.pointerId);
        start = {
          x: event.offsetX,
          y: event.offsetY,
          lastX: event.offsetX,
          lastY: event.offsetY,
          pan: event.button !== 0 || event.pointerType === "touch",
        };
        scene.interacting = true;
      };
      canvas.onpointermove = (event) => {
        if (!start) {
          scene.setHover(scene.overlay.hit(event.offsetX, event.offsetY));
          return;
        }
        if (start.pan) {
          camera.pan(start.lastX - event.offsetX, start.lastY - event.offsetY, true);
          start.lastX = event.offsetX;
          start.lastY = event.offsetY;
          scene.touched = true;
          scene.request();
          return;
        }
        box.hidden = false;
        Object.assign(box.style, {
          left: `${Math.min(start.x, event.offsetX)}px`,
          top: `${Math.min(start.y, event.offsetY)}px`,
          width: `${Math.abs(event.offsetX - start.x)}px`,
          height: `${Math.abs(event.offsetY - start.y)}px`,
        });
      };
      canvas.onpointerup = (event) => {
        if (!start) return;
        const dragged = Math.hypot(event.offsetX - start.x, event.offsetY - start.y) > 4;
        if (!start.pan && dragged) {
          const ids = scene.overlay.inside(
            Math.min(start.x, event.offsetX),
            Math.min(start.y, event.offsetY),
            Math.max(start.x, event.offsetX),
            Math.max(start.y, event.offsetY),
          );
          scene.host.select(event.shiftKey ? [...new Set([...scene.selected, ...ids])] : ids);
        } else if (!start.pan) {
          const unit = scene.overlay.hit(event.offsetX, event.offsetY);
          if (unit && event.shiftKey) {
            const next = new Set(scene.selected);
            if (!next.delete(unit.chat.id)) next.add(unit.chat.id);
            scene.host.select([...next]);
          } else if (unit) scene.host.open(unit.chat.id);
        }
        end();
      };
      canvas.onpointercancel = end;
      canvas.onpointerleave = () => {
        if (!start) scene.setHover(undefined);
      };
      canvas.addEventListener(
        "wheel",
        (event) => {
          event.preventDefault();
          scene.touched = true;
          if (event.ctrlKey || event.metaKey) scene.scale(Math.exp(-event.deltaY * 0.01));
          else {
            camera.pan(event.deltaX, event.deltaY);
            scene.request();
          }
        },
        { passive: false },
      );
      this.keys = (event) => {
        if (
          event.target.matches("input,textarea,button,select,summary") ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        )
          return;
        const step = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        }[event.key];
        if (step) scene.pan(step[0], step[1]);
        else if (event.key === "+" || event.key === "=") scene.scale(1.25);
        else if (event.key === "-") scene.scale(0.8);
        else if (event.key === "0") scene.fit();
        else return;
        event.preventDefault();
      };
      window.addEventListener("keydown", this.keys);
    }
    dispose() {
      window.removeEventListener("keydown", this.keys);
    }
  };
})();
