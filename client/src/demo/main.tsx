import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Demo } from "./Demo.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
    <StrictMode>
        <Demo />
    </StrictMode>,
);