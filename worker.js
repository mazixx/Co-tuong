let python = null;
let initializationError = null;

async function initialize() {
  const base =
    "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";

  importScripts(base + "pyodide.js");

  python = await loadPyodide({
    indexURL: base
  });

  for (const filename of [
    "engine.py",
    "web_controller.py"
  ]) {
    const url = new URL(filename, self.location.href);
    const response = await fetch(url, {
      cache: "no-cache"
    });

    if (!response.ok) {
      throw new Error(
        `Không tải được ${filename}: HTTP ${response.status}\n`
        + url.href
      );
    }

    python.FS.writeFile(
      "/home/pyodide/" + filename,
      await response.text()
    );
  }

  python.runPython(`
import sys
sys.path.insert(0, "/home/pyodide")
from web_controller import api
`);

  self.postMessage({type: "ready"});
}

const ready = initialize().catch(error => {
  initializationError = error;

  self.postMessage({
    type: "fatal",
    error: String(error)
  });
});

self.onmessage = async event => {
  const {id, request} = event.data;

  try {
    await ready;

    if (initializationError) {
      throw initializationError;
    }

    python.globals.set(
      "_web_request",
      JSON.stringify(request)
    );

    const result = python.runPython(
      "api(_web_request)"
    );

    self.postMessage({
      type: "result",
      id,
      ok: true,
      result: JSON.parse(result)
    });

  } catch (error) {
    self.postMessage({
      type: "result",
      id,
      ok: false,
      error: String(error)
    });
  }
};
