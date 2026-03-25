import pino from "pino";

export interface Transition<TState extends string, TEvent extends string, TContext> {
  from: TState | TState[];
  event: TEvent;
  to: TState;
  guard?: (ctx: TContext) => boolean;
}

export interface StateActions<TState extends string, TContext> {
  onEntry?: (ctx: TContext) => void | Promise<void>;
  onExit?: (ctx: TContext) => void | Promise<void>;
}

export interface StateMachineConfig<
  TState extends string,
  TEvent extends string,
  TContext,
> {
  initial: TState;
  context: TContext;
  transitions: Transition<TState, TEvent, TContext>[];
  stateActions?: Partial<Record<TState, StateActions<TState, TContext>>>;
  log?: pino.Logger;
}

export class StateMachine<
  TState extends string,
  TEvent extends string,
  TContext,
> {
  private state: TState;
  private stateEnteredAt: number = Date.now();
  readonly context: TContext;
  private readonly transitions: Transition<TState, TEvent, TContext>[];
  private readonly stateActions: Partial<Record<TState, StateActions<TState, TContext>>>;
  private readonly log: pino.Logger;
  private readonly eventQueue: TEvent[] = [];
  private processing = false;

  constructor(config: StateMachineConfig<TState, TEvent, TContext>) {
    this.state = config.initial;
    this.context = config.context;
    this.transitions = config.transitions;
    this.stateActions = config.stateActions ?? {};
    this.log = config.log ?? pino({ name: "StateMachine" });
  }

  current(): TState {
    return this.state;
  }

  stateAge(): number {
    return Date.now() - this.stateEnteredAt;
  }

  async send(event: TEvent): Promise<void> {
    this.eventQueue.push(event);
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.eventQueue.length > 0) {
        const next = this.eventQueue.shift()!;
        await this.processEvent(next);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processEvent(event: TEvent): Promise<void> {
    const match = this.transitions.find((t) => {
      const froms = Array.isArray(t.from) ? t.from : [t.from];
      if (!froms.includes(this.state)) return false;
      if (t.event !== event) return false;
      if (t.guard && !t.guard(this.context)) return false;
      return true;
    });

    if (!match) {
      this.log.warn(
        { currentState: this.state, event },
        "No valid transition found — event ignored",
      );
      return;
    }

    const prev = this.state;
    const prevDurationMs = Date.now() - this.stateEnteredAt;

    // Exit old state
    const exitAction = this.stateActions[prev]?.onExit;
    if (exitAction) await exitAction(this.context);

    // Transition
    this.state = match.to;
    this.stateEnteredAt = Date.now();
    this.log.info(
      { from: prev, to: match.to, event, previousDurationMs: prevDurationMs },
      "State transition",
    );

    // Enter new state
    const entryAction = this.stateActions[match.to]?.onEntry;
    if (entryAction) await entryAction(this.context);
  }
}
