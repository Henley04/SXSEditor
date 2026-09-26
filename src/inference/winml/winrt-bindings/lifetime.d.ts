export declare function trackProjectedValue<T extends object>(value: T, typeName: string): T;
export declare function castProjectedValue<T extends object>(value: T, iid: unknown, typeName: string): T;
export declare function castProjectedValueOwned<T extends object>(value: T, iid: unknown, typeName: string): T;
export declare function castProjectedValueBorrowed<T extends object>(value: T, iid: unknown, typeName: string): T;
export interface ProjectedType<T extends object> {
readonly prototype: T;
}
export declare function projectAs<T extends object>(value: unknown, type: ProjectedType<T>): T;
export declare function releaseProjected(value: object): void;
export interface ProjectedLifetimeScope {
readonly disposed: boolean;
dispose(): void;
}
export declare function createProjectedLifetimeScope(): ProjectedLifetimeScope;
