import type { Routine, RoutineStatus } from "../types.js";

export class RoutineRegistry {
  private readonly routines = new Map<string, Routine>();
  private sequence = 0;

  create(input: Omit<Routine, "id" | "createdAt" | "updatedAt"> & { id?: string }): Routine {
    const now = new Date().toISOString();
    const routine: Routine = {
      ...input,
      id: input.id ?? `routine_${++this.sequence}`,
      createdAt: now,
      updatedAt: now,
    };
    this.routines.set(routine.id, routine);
    return routine;
  }

  restore(routines: Routine[]): void {
    this.routines.clear();
    this.sequence = 0;

    for (const routine of routines) {
      this.routines.set(routine.id, routine);
      const match = routine.id.match(/^routine_(\d+)$/);
      if (match) {
        this.sequence = Math.max(this.sequence, Number(match[1]));
      }
    }
  }

  get(id: string): Routine | undefined {
    return this.routines.get(id);
  }

  list(status?: RoutineStatus): Routine[] {
    const routines = Array.from(this.routines.values());
    return status ? routines.filter((routine) => routine.status === status) : routines;
  }

  update(id: string, patch: Partial<Omit<Routine, "id" | "createdAt" | "updatedAt">>): Routine {
    const current = this.routines.get(id);
    if (!current) {
      throw new Error(`Routine not found: ${id}`);
    }

    const updated: Routine = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.routines.set(id, updated);
    return updated;
  }
}
