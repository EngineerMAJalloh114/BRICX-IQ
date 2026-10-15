// A decorated class with only a static factory (a Nest dynamic module) is
// allowed in apps/api (P4-01).
const registry: object[] = [];

function Module(metadata: object) {
  return <T>(target: T, context: ClassDecoratorContext): T => {
    context.addInitializer(() => registry.push(metadata));
    return target;
  };
}

@Module({})
export class FeatureModule {
  static forRoot(): object {
    return { module: FeatureModule };
  }
}
