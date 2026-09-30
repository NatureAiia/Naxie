import { ContainerModule } from "@theia/core/shared/inversify";

export default new ContainerModule((bind) => {
  // Backend-side agent routing — placeholder for now.
  // The actual agent gateway will proxy requests to the NeuroWorks
  // server at /api/agents/* which handles model dispatch.
});
