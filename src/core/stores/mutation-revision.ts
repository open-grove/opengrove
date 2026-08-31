import { randomUUID } from "node:crypto";

export class MutationRevision {
  private readonly generation = randomUUID();
  private sequence = 0;

  current(): string {
    return `${this.generation}:${this.sequence}`;
  }

  advance(): void {
    this.sequence += 1;
  }
}
