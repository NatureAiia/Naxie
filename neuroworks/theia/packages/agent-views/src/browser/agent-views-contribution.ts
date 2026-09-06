import { injectable, inject } from "@theia/core/shared/inversify";
import {
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  KeybindingContribution,
  KeybindingRegistry,
} from "@theia/core/lib/common";
import {
  WidgetFactory,
  CommonMenus,
  FrontendApplicationContribution,
  FrontendApplication,
} from "@theia/core/lib/browser";
import { AgentDockFactory } from "./agent-dock-factory";
import { AGENT_DEFINITIONS } from "../common/agent-types";

export const OPEN_AGENT_COMMANDS = AGENT_DEFINITIONS.map((agent) => ({
  id: `naxion.openAgent.${agent.id}`,
  label: `Open ${agent.label}`,
  category: "Naxion" as const,
}));

@injectable()
export class AgentViewsContribution
  implements
    CommandContribution,
    MenuContribution,
    FrontendApplicationContribution,
    KeybindingContribution
{
  @inject(AgentDockFactory)
  protected readonly agentDockFactory: AgentDockFactory;

  initialize(_framework: FrontendApplication): void {
    /* no-op — widgets are created on demand via commands */
  }

  registerCommands(registry: CommandRegistry): void {
    AGENT_DEFINITIONS.forEach((agent, i) => {
      registry.registerCommand(OPEN_AGENT_COMMANDS[i], {
        execute: async () => {
          const widget = await this.agentDockFactory.createWidget(agent.id);
          widget.open();
        },
      });
    });
  }

  registerMenus(menu: MenuModelRegistry): void {
    AGENT_DEFINITIONS.forEach((agent, i) => {
      menu.registerMenuAction([...CommonMenus.MENUBAR, "naxion"], {
        commandId: OPEN_AGENT_COMMANDS[i].id,
        label: agent.label,
        order: "a" + i,
      });
    });
  }

  registerKeybindings(registry: KeybindingRegistry): void {
    registry.registerKeybinding({
      command: OPEN_AGENT_COMMANDS[0].id,
      keybinding: "ctrl+shift+1",
    });
    registry.registerKeybinding({
      command: OPEN_AGENT_COMMANDS[1].id,
      keybinding: "ctrl+shift+2",
    });
    registry.registerKeybinding({
      command: OPEN_AGENT_COMMANDS[2].id,
      keybinding: "ctrl+shift+3",
    });
    registry.registerKeybinding({
      command: OPEN_AGENT_COMMANDS[3].id,
      keybinding: "ctrl+shift+4",
    });
  }
}
