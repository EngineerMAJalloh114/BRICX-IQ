// NestJS-style constructor injection: Nest reads the constructor's
// `design:paramtypes` metadata to know what to inject. That metadata exists
// only if the compiler emits it (emitDecoratorMetadata).
export const Injectable = (): ClassDecorator => () => undefined;

export class Clock {
  readonly zone = "UTC";
}

@Injectable()
export class InvoiceService {
  constructor(readonly clock: Clock) {}
}
