import { Link, Route, Switch } from "wouter";
import { Separator } from "@/components/ui/separator";
import { DaemonBanner } from "@/components/DaemonBanner";
import { JobsPage } from "./pages/Jobs";
import { InvocationsPage } from "./pages/Invocations";
import { AllInvocationsPage } from "./pages/AllInvocations";
import { LogViewerPage } from "./pages/LogViewer";

export default function App(): React.ReactElement {
  return (
    <div className="flex h-full flex-col bg-background">
      <header className="border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link
            to="/"
            className="flex items-center gap-2 font-heading text-sm font-semibold tracking-tight"
          >
            <span className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
              <span className="text-[10px]">cf</span>
            </span>
            cronfish
          </Link>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <Link to="/" className="hover:text-foreground">
              jobs
            </Link>
            <Link to="/runs" className="hover:text-foreground">
              all runs
            </Link>
            <Separator orientation="vertical" className="h-4" />
            <a
              href="https://github.com/goldcaddy77/cronfish"
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              docs
            </a>
            <Separator orientation="vertical" className="h-4" />
            <span className="font-mono">127.0.0.1</span>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-6 pt-4">
        <DaemonBanner />
      </div>

      <main className="mx-auto w-full max-w-6xl flex-1 min-h-0 px-6 py-6">
        <Switch>
          <Route path="/" component={JobsPage} />
          <Route path="/runs" component={AllInvocationsPage} />
          <Route path="/jobs/:slug">
            {(params) => (
              <InvocationsPage
                slug={decodeURIComponent(params.slug as string)}
              />
            )}
          </Route>
          <Route path="/invocations/:id">
            {(params) => (
              <LogViewerPage id={parseInt(params.id as string, 10)} />
            )}
          </Route>
          <Route>
            <p className="text-sm text-muted-foreground">not found</p>
          </Route>
        </Switch>
      </main>
    </div>
  );
}
