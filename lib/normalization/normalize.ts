import type { StoreApp } from "@/types/lead";

function preferString(current: string | null, incoming: string | null): string | null {
  if (incoming && incoming.length > (current?.length ?? 0)) return incoming;
  return current ?? incoming;
}

/** Fills holes in `current` with data from `incoming` (never overwrites richer values). */
export function mergeStoreApp(current: StoreApp, incoming: StoreApp): StoreApp {
  return {
    ...current,
    title: preferString(current.title, incoming.title) ?? current.title,
    developer: preferString(current.developer, incoming.developer),
    category: preferString(current.category, incoming.category),
    summary: preferString(current.summary, incoming.summary),
    description: preferString(current.description, incoming.description),
    icon: current.icon ?? incoming.icon,
    urlPath: current.urlPath ?? incoming.urlPath,
    rating: current.rating ?? incoming.rating,
    ratingRaw: current.ratingRaw ?? incoming.ratingRaw,
    ratingsCount: current.ratingsCount ?? incoming.ratingsCount,
    installs: current.installs ?? incoming.installs,
    installsRaw: current.installsRaw ?? incoming.installsRaw,
    installsUpper: current.installsUpper ?? incoming.installsUpper,
  };
}

export class AppRegistry {
  private readonly apps = new Map<string, StoreApp>();
  private readonly order: string[] = [];

  add(app: StoreApp): { isNew: boolean } {
    const existing = this.apps.get(app.packageName);
    if (!existing) {
      this.apps.set(app.packageName, app);
      this.order.push(app.packageName);
      return { isNew: true };
    }
    this.apps.set(app.packageName, mergeStoreApp(existing, app));
    return { isNew: false };
  }

  has(packageName: string): boolean {
    return this.apps.has(packageName);
  }

  get(packageName: string): StoreApp | undefined {
    return this.apps.get(packageName);
  }

  get size(): number {
    return this.apps.size;
  }

  values(): StoreApp[] {
    return this.order.map((packageName) => this.apps.get(packageName)!);
  }

  keys(): string[] {
    return [...this.order];
  }

  restore(packages: string[]): void {
    for (const packageName of packages) {
      if (!this.apps.has(packageName)) {
        this.apps.set(packageName, {
          packageName,
          title: packageName,
          developer: null,
          rating: null,
          ratingRaw: null,
          ratingsCount: null,
          installsRaw: null,
          installs: null,
          installsUpper: null,
          category: null,
          summary: null,
          description: null,
          icon: null,
          urlPath: null,
        });
        this.order.push(packageName);
      }
    }
  }
}
