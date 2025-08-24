import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Verificar que exista el contenedor "root"
let rootElement = document.getElementById("root");
if (!rootElement) {
  rootElement = document.createElement("div");
  rootElement.id = "root";
  document.body.appendChild(rootElement);
}

const root = ReactDOM.createRoot(rootElement);
root.render(<App />);

// ...existing code if needed...
