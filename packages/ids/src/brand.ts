// Nominal ("branded") types: a value of Brand<T, "X"> is a T that has been
// checked to be an X. Several brands intersect, so an OrgId is also a
// UuidV7 but never a UserId. Type-only: nothing exists at run time.
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & {
  readonly [brand]: { readonly [K in B]: true };
};
