const $ = id => document.getElementById(id);

const worker = new Worker(
  new URL("./worker.js", document.baseURI)
);

const pending = new Map();

let serial = 0;
let ready = false;
let busy = false;
let state = null;
let receivedAt = 0;
let selected = null;
let boardKey = "";
let sceneTheme = -1;
let autoStopped = false;
let deferredPause = false;

const board = $("board");
const ctx = board.getContext("2d");

const FONT =
  '"Noto Serif SC","Microsoft YaHei","PingFang SC",serif';

function rpc(request) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, {resolve, reject});
    worker.postMessage({id, request});
  });
}

function rejectAll(message) {
  for (const task of pending.values()) {
    task.reject(new Error(message));
  }
  pending.clear();
}

worker.onmessage = event => {
  const message = event.data;

  if (message.type === "ready") {
    ready = true;
    command({op: "new", level: 0});
    return;
  }

  if (message.type === "fatal") {
    ready = false;
    $("error").textContent = message.error;
    $("loading").textContent = "Không khởi động được Python.";
    rejectAll(message.error);
    controls();
    return;
  }

  const task = pending.get(message.id);
  if (!task) return;

  pending.delete(message.id);

  if (message.ok) task.resolve(message.result);
  else task.reject(new Error(message.error));
};

worker.onerror = event => {
  ready = false;
  const message = event.message || "Worker gặp lỗi.";
  $("error").textContent = message;
  $("loading").textContent = "Worker đã dừng.";
  rejectAll(message);
  controls();
};

async function command(request) {
  if (!ready || busy) return;

  busy = true;

  if (request.op !== "tick") {
    $("error").textContent = "";
  }

  if (request.op === "ai") {
    $("loading").textContent = "Máy đang phân tích…";
  } else if (request.op === "hint") {
    $("loading").textContent = "Quân sư đang phân tích gợi ý…";
  }

  controls();

  try {
    const result = await rpc(request);

    state = result.state;
    receivedAt = performance.now();

    const nextKey = JSON.stringify(state.board);

    if (nextKey !== boardKey || request.op === "new") {
      selected = null;
      boardKey = nextKey;
    }

    if (
      request.op === "new"
      || (request.op === "pause" && request.value === false)
    ) {
      autoStopped = false;
    }

    render();

  } catch (error) {
    $("error").textContent = String(error.message || error);

    if (["ai", "hint", "tick"].includes(request.op)) {
      autoStopped = true;
      $("error").textContent +=
        "\nTự động đã dừng. Hãy thử Tiếp tục hoặc tạo ván mới.";
    }

  } finally {
    busy = false;
    controls();

    if (
      state && !state.finished && !state.paused
      && (deferredPause || document.hidden)
    ) {
      deferredPause = false;
      command({op: "pause", value: true});
    }
  }
}

function controls() {
  const playing = Boolean(
    state && !state.finished && !state.paused
  );

  $("new").disabled = !ready || busy;
  $("level").disabled = !ready || busy;
  $("theme").disabled = !state || busy;

  $("pause").disabled = !state || busy || state.finished;
  $("pause").textContent = (
    state && (state.paused || autoStopped)
  ) ? "Tiếp tục" : "Tạm dừng";

  $("undo").disabled = (
    !state || busy || !state.can_undo || autoStopped
  );

  $("undo").textContent =
    `Xin đi lại (${state ? state.undo_left : 2})`;

  $("draw").disabled = (
    !playing || busy || state.turn !== 1 || autoStopped
  );

  $("resign").disabled = !playing || busy || autoStopped;

  if (ready && !busy) {
    $("loading").textContent =
      "Python đã sẵn sàng • Game chạy trên thiết bị của bạn";
  }
}

function timeString(seconds) {
  seconds = Math.max(0, Math.ceil(seconds));

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  return (
    String(minutes).padStart(2, "0")
    + ":"
    + String(rest).padStart(2, "0")
  );
}

function updateClocks() {
  if (!state) return;

  const times = [...state.remaining];

  if (
    !state.paused && !state.finished && !autoStopped
  ) {
    const elapsed = (
      performance.now() - receivedAt
    ) / 1000;

    const index = state.turn === 1 ? 0 : 1;
    times[index] = Math.max(0, times[index] - elapsed);
  }

  $("redTime").textContent = timeString(times[0]);
  $("blackTime").textContent = timeString(times[1]);

  $("redTime").classList.toggle("low", times[0] < 60);
  $("blackTime").classList.toggle("low", times[1] < 60);

  const active = !state.paused && !state.finished;

  $("redClock").classList.toggle(
    "active", active && state.turn === 1
  );

  $("blackClock").classList.toggle(
    "active", active && state.turn === -1
  );
}

function render() {
  $("level").value = String(state.level);
  $("message").textContent = state.message;
  $("note").textContent = state.note;
  $("hint").textContent = state.hint_status;
  $("aiInfo").textContent = state.ai_info;

  $("evaluation").textContent =
    `Ước lượng tĩnh: Đỏ ${state.evaluation >= 0 ? "+" : ""}`
    + `${state.evaluation.toFixed(1)} binh`;

  $("themeName").textContent =
    `Nền ${state.theme + 1}/10: `
    + state.themes[state.theme][0];

  const historyText = state.history.map((entry, index) => {
    const owner = entry.side === 1 ? "Đỏ" : "Đen";

    return (
      `${Math.floor(index / 2) + 1}. ${owner}: ${entry.name}\n`
      + `    ${entry.comment}`
    );
  }).join("\n");

  if (
    $("history").textContent
    !== (historyText || "Chưa có nước đi.")
  ) {
    $("history").textContent =
      historyText || "Chưa có nước đi.";

    $("history").scrollTop = $("history").scrollHeight;
  }

  if (sceneTheme !== state.theme) {
    sceneTheme = state.theme;
    drawScene();
  }

  drawBoard();
  updateClocks();
}

function point(row, col) {
  return [40 + col * 60, 35 + row * 60];
}

function line(x1, y1, x2, y2, color, width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function circle(x, y, radius, color, width = 2) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function disk(x, y, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function seeded(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function drawArrow(move) {
  const [r1, c1, r2, c2] = move;
  let [x1, y1] = point(r1, c1);
  let [x2, y2] = point(r2, c2);

  const length = Math.hypot(x2 - x1, y2 - y1);
  if (!length) return;

  const dx = (x2 - x1) / length;
  const dy = (y2 - y1) / length;

  x1 += dx * 27;
  y1 += dy * 27;
  x2 -= dx * 14;
  y2 -= dy * 14;

  line(x1, y1, x2, y2, "#1d9253", 5);

  ctx.fillStyle = "#1d9253";
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - dx * 18 - dy * 10,
    y2 - dy * 18 + dx * 10
  );
  ctx.lineTo(
    x2 - dx * 18 + dy * 10,
    y2 - dy * 18 - dx * 10
  );
  ctx.closePath();
  ctx.fill();
}

function drawPiece(piece, x, y) {
  const side = piece > 0 ? "1" : "-1";
  const color = piece > 0 ? "#a62324" : "#1c4f3e";

  ctx.save();

  ctx.shadowColor = "#0007";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 4;

  disk(x, y + 2, 27, "#8b6d3e");

  ctx.shadowColor = "transparent";

  const fill = ctx.createRadialGradient(
    x - 8, y - 10, 1, x, y, 27
  );

  fill.addColorStop(0, "#fff8d8");
  fill.addColorStop(1, "#d9c590");

  disk(x, y, 27, fill);

  circle(x, y, 25, "#fff9df", 2);
  circle(x, y, 23, color, 2);
  circle(x, y, 19, "#bba574", 1);

  ctx.fillStyle = color;
  ctx.font = `34px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillText(
    state.han[side][Math.abs(piece)],
    x,
    y + 1
  );

  ctx.restore();
}

function drawBoard() {
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.clearRect(0, 0, 560, 610);

  const wood = ctx.createLinearGradient(0, 0, 0, 610);
  wood.addColorStop(0, "#f6e6b0");
  wood.addColorStop(1, "#d9c28a");

  ctx.fillStyle = wood;
  ctx.fillRect(0, 0, 560, 610);

  const random = seeded(42);

  for (let i = 0; i < 500; i++) {
    const x = 8 + random() * 540;
    const y = 8 + random() * 590;

    line(
      x, y,
      Math.min(551, x + 3 + random() * 14), y,
      "#92744418",
      1
    );
  }

  ctx.strokeStyle = "#896b3c";
  ctx.lineWidth = 4;
  ctx.strokeRect(3, 3, 554, 604);

  ctx.lineWidth = 1;
  ctx.strokeRect(10, 10, 540, 590);

  const ink = "#856f46";

  for (let row = 0; row < 10; row++) {
    const [x1, y1] = point(row, 0);
    const [x2, y2] = point(row, 8);

    line(x1, y1, x2, y2, ink, 1.5);

    ctx.fillStyle = ink;
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(row), 21, y1);
  }

  for (let col = 0; col < 9; col++) {
    const x = point(0, col)[0];

    if (col === 0 || col === 8) {
      line(x, 35, x, 575, ink, 1.5);
    } else {
      line(x, 35, x, 275, ink, 1.5);
      line(x, 335, x, 575, ink, 1.5);
    }

    ctx.fillStyle = ink;
    ctx.font = "12px system-ui";
    ctx.fillText(String.fromCharCode(65 + col), x, 598);
  }

  for (const top of [0, 7]) {
    const a = point(top, 3);
    const b = point(top + 2, 5);
    const c = point(top, 5);
    const d = point(top + 2, 3);

    line(...a, ...b, ink, 1.5);
    line(...c, ...d, ink, 1.5);
  }

  for (const [row, columns] of [
    [2, [1, 7]],
    [7, [1, 7]],
    [3, [0, 2, 4, 6, 8]],
    [6, [0, 2, 4, 6, 8]]
  ]) {
    for (const col of columns) {
      const [x, y] = point(row, col);

      for (const sx of [-1, 1]) {
        if (
          (col === 0 && sx === -1)
          || (col === 8 && sx === 1)
        ) continue;

        for (const sy of [-1, 1]) {
          line(
            x + sx * 13, y + sy * 5,
            x + sx * 5, y + sy * 5,
            ink
          );
          line(
            x + sx * 5, y + sy * 5,
            x + sx * 5, y + sy * 13,
            ink
          );
        }
      }
    }
  }

  ctx.fillStyle = "#81643a";
  ctx.font = `27px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("楚 河", 170, 305);
  ctx.fillText("漢 界", 395, 305);

  if (!state) return;

  if (state.paused) {
    ctx.fillStyle = "#061713db";
    ctx.fillRect(0, 0, 560, 610);

    ctx.fillStyle = "#e7cc84";
    ctx.font = "bold 28px system-ui";
    ctx.fillText("TẠM DỪNG", 280, 275);

    ctx.fillStyle = "#fcefc5";
    ctx.font = "18px system-ui";
    ctx.fillText("Nhấn Tiếp tục để chơi", 280, 325);
    return;
  }

  if (state.last) {
    const [r1, c1, r2, c2] = state.last;

    ctx.strokeStyle = "#4f877a";
    ctx.lineWidth = 2;

    for (const [r, c] of [[r1, c1], [r2, c2]]) {
      const [x, y] = point(r, c);
      ctx.strokeRect(x - 28, y - 28, 56, 56);
    }
  }

  if (state.hint && !state.finished && state.turn === 1) {
    drawArrow(state.hint);
  }

  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = state.board[row][col];
      if (piece) drawPiece(piece, ...point(row, col));
    }
  }

  if (state.king) {
    circle(...point(...state.king), 29, "#e64e28", 3);
  }

  if (selected && !state.finished && state.turn === 1) {
    circle(...point(...selected), 29, "#1c8f5a", 3);

    for (const [r1, c1, r2, c2] of state.moves) {
      if (r1 !== selected[0] || c1 !== selected[1]) {
        continue;
      }

      const [x, y] = point(r2, c2);

      if (state.board[r2][c2]) {
        circle(x, y, 29, "#1c8f5a", 3);
      } else {
        disk(x, y, 7, "#1c8f5a");
      }
    }

    for (const [r1, c1, r2, c2] of state.blocked) {
      if (r1 !== selected[0] || c1 !== selected[1]) {
        continue;
      }

      const [x, y] = point(r2, c2);

      line(x - 9, y - 9, x + 9, y + 9, "#be3e28", 3);
      line(x + 9, y - 9, x - 9, y + 9, "#be3e28", 3);
    }
  }
}

board.addEventListener("pointerdown", event => {
  if (
    !state || busy || state.paused || state.finished
    || state.turn !== 1 || autoStopped
  ) return;

  const rect = board.getBoundingClientRect();
  const x = (event.clientX - rect.left) * 560 / rect.width;
  const y = (event.clientY - rect.top) * 610 / rect.height;

  const col = Math.round((x - 40) / 60);
  const row = Math.round((y - 35) / 60);

  if (row < 0 || row > 9 || col < 0 || col > 8) {
    selected = null;
    drawBoard();
    return;
  }

  const [px, py] = point(row, col);

  if (Math.hypot(x - px, y - py) > 28) {
    selected = null;
    drawBoard();
    return;
  }

  if (selected) {
    const move = [selected[0], selected[1], row, col];

    const same = candidate =>
      candidate.every((value, index) => value === move[index]);

    if (state.moves.some(same)) {
      command({op: "move", move});
      return;
    }

    if (state.blocked.some(same)) {
      $("error").textContent =
        "Nước này bị cấm vì tạo cùng thế cờ lần thứ ba.";
      return;
    }
  }

  selected = state.board[row][col] > 0 ? [row, col] : null;
  drawBoard();
});

function rgb(value) {
  return `rgb(${value.join(",")})`;
}

function drawScene() {
  const canvas = $("scene");
  const c = canvas.getContext("2d");
  const ratio = Math.min(window.devicePixelRatio || 1, 2);

  const width = window.innerWidth;
  const height = window.innerHeight;

  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  c.setTransform(ratio, 0, 0, ratio, 0, 0);

  if (!state) {
    c.fillStyle = "#10271f";
    c.fillRect(0, 0, width, height);
    return;
  }

  const [, top, bottom, mountain, accent, kind] =
    state.themes[state.theme];

  const random = seeded(1307 + state.theme);
  const gradient = c.createLinearGradient(0, 0, 0, height);

  gradient.addColorStop(0, rgb(top));
  gradient.addColorStop(1, rgb(bottom));

  c.fillStyle = gradient;
  c.fillRect(0, 0, width, height);

  if (["sunset", "night", "purple", "sea", "snow"].includes(kind)) {
    c.fillStyle = rgb(accent);
    c.beginPath();
    c.arc(width * .82, height * .14, 38, 0, Math.PI * 2);
    c.fill();
  }

  if (["night", "purple"].includes(kind)) {
    c.fillStyle = rgb(accent);

    for (let i = 0; i < 85; i++) {
      c.fillRect(
        random() * width,
        random() * height * .45,
        2, 2
      );
    }
  }

  for (let layer = 0; layer < 5; layer++) {
    c.fillStyle = rgb(mountain);
    c.globalAlpha = .45 + layer * .1;
    c.beginPath();
    c.moveTo(-30, height);

    for (let x = -30; x <= width + 70; x += 70) {
      const y =
        height * (.27 + layer * .12)
        + Math.sin(x * .008 + layer) * 55
        + random() * 65;

      c.lineTo(x, y);
    }

    c.lineTo(width + 70, height);
    c.closePath();
    c.fill();
  }

  c.globalAlpha = 1;

  if (["bamboo", "ink", "mountain"].includes(kind)) {
    for (let i = 0; i < 16; i++) {
      const x = i < 8
        ? random() * width * .15
        : width * (.85 + random() * .15);

      const lean = (random() - .5) * 80;

      c.strokeStyle = rgb(accent);
      c.globalAlpha = .25;
      c.lineWidth = 5 + random() * 8;

      c.beginPath();
      c.moveTo(x, height);
      c.lineTo(x + lean, 0);
      c.stroke();

      c.lineWidth = 2;

      for (let y = 50; y < height; y += 90) {
        for (const side of [-1, 1]) {
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x + side * 45, y - 30);
          c.stroke();
        }
      }
    }
  }

  if (["sakura", "autumn"].includes(kind)) {
    c.fillStyle = rgb(accent);
    c.globalAlpha = .4;

    for (let i = 0; i < 120; i++) {
      const x = random() < .5
        ? random() * width * .18
        : width * (.82 + random() * .18);

      c.beginPath();
      c.arc(
        x, random() * height,
        2 + random() * 5,
        0, Math.PI * 2
      );
      c.fill();
    }
  }

  c.globalAlpha = 1;
  c.fillStyle = "#00000030";
  c.fillRect(0, 0, width, height);
}

$("new").onclick = () => {
  if (
    state && !state.finished
    && !window.confirm("Bắt đầu ván mới? Ván hiện tại sẽ mất.")
  ) return;

  command({
    op: "new",
    level: Number($("level").value)
  });
};

$("level").onchange = () => {
  command({
    op: "new",
    level: Number($("level").value)
  });
};

$("pause").onclick = () => {
  command({
    op: "pause",
    value: autoStopped ? false : !state.paused
  });
};

$("theme").onclick = () => command({op: "theme"});
$("undo").onclick = () => command({op: "undo"});
$("draw").onclick = () => command({op: "draw"});

$("resign").onclick = () => {
  if (window.confirm("Bạn muốn nhận thua ván này?")) {
    command({op: "resign"});
  }
};

document.addEventListener("visibilitychange", () => {
  if (
    document.hidden && state
    && !state.finished && !state.paused
  ) {
    if (busy) deferredPause = true;
    else command({op: "pause", value: true});
  }
});

window.addEventListener("resize", drawScene);

setInterval(updateClocks, 100);

setInterval(() => {
  if (
    !ready || busy || !state
    || state.finished || state.paused
    || document.hidden || autoStopped
  ) return;

  if (state.turn === -1) {
    command({op: "ai"});
  } else if (state.hint_due) {
    command({op: "hint"});
  } else {
    command({op: "tick"});
  }
}, 250);

drawScene();
drawBoard();
