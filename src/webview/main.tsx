import * as React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./main.css";
import type { VsCodeApi } from "./types";

declare function acquireVsCodeApi(): VsCodeApi;

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing webview root element");
}

const vscode = acquireVsCodeApi();
const root = createRoot(rootElement);
root.render(<App vscode={vscode} />);
