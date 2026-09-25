import { CalendarDays } from "lucide-react";
import { MyTasks } from "./MyTasks";

export function Planner() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3">
          <CalendarDays size={24} /> Planner
        </h1>
        <p className="text-sm text-cream-300/70 mt-1">
          Tasks, reminders, and calendar in one place — My Day, Important, and Calendar all live in the left nav.
        </p>
      </div>
      <MyTasks />
    </div>
  );
}
