import { useState } from "react";
import { createRoot } from "react-dom/client";
import { connectViaWebSocket } from "@zcode/client";
import type { VirtualProject } from "../../../../ui/src/project-sidebar/contract.js";
import { isLocale } from "@zcode/shared";
import { ZCodeIntlProvider } from "../../../../ui/src/i18n/IntlProvider.js";
import { ProjectCreation } from "../../../../ui/src/project-sidebar/ProjectCreation.js";
import "../../../../ui/src/styles.css";

const params = new URLSearchParams(location.search);
const wsUrl = params.get("ws");
const workspacePath = params.get("workspace");
if (!wsUrl || !workspacePath) throw new Error("Picker fixture requires ws and workspace");
const workspace = workspacePath;
const requestedLocale = params.get("locale");
if (!isLocale(requestedLocale)) throw new Error("Picker fixture requires a supported locale");
const locale = requestedLocale;
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.className = theme === "dark" ? "dark theme-zai-dark" : "theme-zai-light";

let socket: WebSocket | undefined;
const services = await connectViaWebSocket(wsUrl, {
  onOpenSocket: (opened) => {
    socket = opened;
  },
});
addEventListener("pagehide", () => socket?.close(), { once: true });
if (!services.projectService || !services.remoteProjectService)
  throw new Error("Picker fixture requires project and remote project services");
const service = services.projectService;
const remoteService = services.remoteProjectService;
const [initialProjects, directory] = await Promise.all([
  service.readProjects(),
  remoteService.readDirectory(),
]);

function Picker() {
  const [open, setOpen] = useState(true);
  const [projects, setProjects] = useState<VirtualProject[]>(initialProjects);
  const [saved, setSaved] = useState(0);
  return (
    <ZCodeIntlProvider initialLocale={locale}>
      <main data-testid="picker-ready" className="min-h-screen bg-background text-foreground">
        <button data-testid="picker-open" onClick={() => setOpen(true)}>
          New project
        </button>
        <output data-testid="picker-saved">{saved}</output>
        {!open ? <output data-testid="picker-closed">Closed</output> : null}
        {open ? (
          <ProjectCreation
            workspacePath={workspace}
            projects={projects}
            directory={directory}
            service={service}
            remoteService={remoteService}
            defaultDeviceId="local"
            onClose={() => setOpen(false)}
            onSaved={async () => {
              setProjects(await service.readProjects());
              setSaved((count) => count + 1);
            }}
            onCreateTask={() => undefined}
          />
        ) : null}
      </main>
    </ZCodeIntlProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Picker fixture root is missing");
createRoot(root).render(<Picker />);
