// Without a decorator, a static-only class is still an error in apps/api.
export class Helpers {
  static double(value: number): number {
    return value * 2;
  }
}
