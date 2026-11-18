"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Bold,
  ChevronDown,
  Home,
  Inbox,
  Italic,
  Plus,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import {
  boolean,
  email,
  enum as zEnum,
  maxLength,
  minLength,
  object,
  string,
  type infer as Infer,
} from "zod/mini";

import { ThemeToggle } from "@/components/theme-toggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileDrop } from "@/components/ui/file-drop";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  EmptyState,
  ErrorState,
  FieldError,
  LoadingState,
} from "@/components/ui/states";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { createFormatter } from "@/lib/format";

// ── sample data (fixed, so the page renders identically every time) ─────────

type Invoice = {
  id: string;
  customer: string;
  status: "paid" | "pending" | "overdue";
  amount: number; // minor units
  due: string; // calendar date
};

const INVOICES: Invoice[] = [
  {
    id: "INV-001",
    customer: "Northwind",
    status: "paid",
    amount: 125_000,
    due: "2026-03-01",
  },
  {
    id: "INV-002",
    customer: "Contoso",
    status: "pending",
    amount: 48_050,
    due: "2026-03-14",
  },
  {
    id: "INV-003",
    customer: "Fabrikam",
    status: "overdue",
    amount: 9_999,
    due: "2026-02-20",
  },
  {
    id: "INV-004",
    customer: "Adventure Works",
    status: "paid",
    amount: 1_200_000,
    due: "2026-04-02",
  },
];

const STATUS_VARIANT = {
  paid: "secondary",
  pending: "outline",
  overdue: "destructive",
} as const;

const NOW = "2026-03-07T12:00:00Z";
const FORMATTERS = {
  "en-US · USD · New York": createFormatter({
    locale: "en-US",
    currency: "USD",
    timeZone: "America/New_York",
  }),
  "en-GB · GBP · London": createFormatter({
    locale: "en-GB",
    currency: "GBP",
    timeZone: "Europe/London",
  }),
  "de-DE · EUR · Berlin": createFormatter({
    locale: "de-DE",
    currency: "EUR",
    timeZone: "Europe/Berlin",
  }),
  "ja-JP · JPY · Tokyo": createFormatter({
    locale: "ja-JP",
    currency: "JPY",
    timeZone: "Asia/Tokyo",
  }),
};
const fmt = FORMATTERS["en-US · USD · New York"];

const invoiceColumns: DataTableColumn<Invoice>[] = [
  {
    key: "id",
    header: "Invoice",
    cell: (r) => <span className="font-medium">{r.id}</span>,
    sortValue: (r) => r.id,
  },
  {
    key: "customer",
    header: "Customer",
    cell: (r) => r.customer,
    sortValue: (r) => r.customer,
  },
  {
    key: "status",
    header: "Status",
    cell: (r) => <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>,
    sortValue: (r) => r.status,
  },
  {
    key: "due",
    header: "Due",
    cell: (r) => fmt.date(r.due),
    sortValue: (r) => r.due,
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    cell: (r) => fmt.money(r.amount),
    sortValue: (r) => r.amount,
  },
];

// Client forms import from "zod/mini" by name (see docs/guide.md "UI"): the same
// validation as classic zod at a fraction of the browser bundle.
const profileSchema = object({
  username: string().check(minLength(2, "At least 2 characters.")),
  email: email("Enter a valid email address."),
  role: zEnum(["owner", "admin", "member"], "Pick a role."),
  bio: string().check(maxLength(160, "160 characters at most.")),
  notify: boolean(),
});
type Profile = Infer<typeof profileSchema>;

const TOKENS = [
  "background",
  "foreground",
  "card",
  "primary",
  "secondary",
  "muted",
  "accent",
  "destructive",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
];

// ── layout helpers ──────────────────────────────────────────────────────────

const SECTIONS = [
  "Tokens",
  "Buttons",
  "Badges & avatars",
  "Inputs",
  "Form",
  "Overlays",
  "Menus",
  "Tabs & cards",
  "Tables",
  "States",
  "Files",
  "Toasts",
  "Sidebar",
  "Formatting",
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, "-");

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={slug(title)} className="scroll-mt-20 space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
      <Separator className="mt-10" />
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

// ── the page ────────────────────────────────────────────────────────────────

export function Styleguide() {
  return (
    <TooltipProvider>
      <div className="min-h-dvh">
        <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
            <Link href="/" className="font-semibold">
              Design system
            </Link>
            <span className="hidden text-sm text-muted-foreground sm:inline">
              shadcn/ui · new-york · neutral
            </span>
            <ThemeToggle className="ml-auto" />
          </div>
        </header>

        <div className="mx-auto grid max-w-5xl gap-10 px-4 py-8 lg:grid-cols-[10rem_1fr]">
          <nav aria-label="Sections" className="hidden lg:block">
            <ul className="sticky top-20 space-y-1 text-sm">
              {SECTIONS.map((s) => (
                <li key={s}>
                  <a
                    href={`#${slug(s)}`}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {s}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <main className="min-w-0 space-y-10">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">
                Components
              </h1>
              <p className="mt-1 text-muted-foreground">
                Everything in{" "}
                <code className="font-mono text-sm">src/components/ui</code>.
                Use these — do not hand-roll a button or a modal. Toggle the
                theme (top right) to check both palettes.
              </p>
            </div>

            <Tokens />
            <Buttons />
            <BadgesAvatars />
            <Inputs />
            <ProfileForm />
            <Overlays />
            <Menus />
            <TabsCards />
            <Tables />
            <States />
            <Files />
            <Toasts />
            <SidebarDemo />
            <Formatting />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Tokens() {
  return (
    <Section
      title="Tokens"
      description="CSS variables in app/globals.css (:root and .dark). Change them there to re-skin everything."
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {TOKENS.map((t) => (
          <div key={t} className="flex items-center gap-2 text-sm">
            <span
              className="size-8 shrink-0 rounded-md border"
              style={{ background: `var(--${t})` }}
            />
            <code className="font-mono text-xs">--{t}</code>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Buttons() {
  return (
    <Section
      title="Buttons"
      description="Variants and sizes. Icon-only buttons need an aria-label."
    >
      <Row>
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
      </Row>
      <Row>
        <Button size="sm">Small</Button>
        <Button>Default</Button>
        <Button size="lg">Large</Button>
        <Button>
          <Plus /> With icon
        </Button>
        <Button size="icon" aria-label="Add">
          <Plus />
        </Button>
        <Button disabled>Disabled</Button>
      </Row>
    </Section>
  );
}

function BadgesAvatars() {
  return (
    <Section title="Badges & avatars">
      <Row>
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="destructive">Destructive</Badge>
      </Row>
      <Row>
        <Avatar>
          <AvatarFallback>AL</AvatarFallback>
        </Avatar>
        <Avatar className="size-10">
          <AvatarFallback>GH</AvatarFallback>
        </Avatar>
      </Row>
    </Section>
  );
}

function Inputs() {
  const [checked, setChecked] = useState(true);
  return (
    <Section
      title="Inputs"
      description="Every control has a visible <Label htmlFor>. Errors use aria-invalid."
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="sg-email">Email</Label>
          <Input id="sg-email" type="email" placeholder="you@example.com" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sg-invalid">Invalid</Label>
          <Input id="sg-invalid" aria-invalid defaultValue="not-an-email" />
          <FieldError>Enter a valid email address.</FieldError>
        </div>
        <div className="space-y-2">
          <Label htmlFor="sg-select">Select</Label>
          <Select defaultValue="weekly">
            <SelectTrigger id="sg-select" className="w-full">
              <SelectValue placeholder="Pick one" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="sg-disabled">Disabled</Label>
          <Input id="sg-disabled" disabled placeholder="Read only" />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="sg-notes">Notes</Label>
          <Textarea id="sg-notes" placeholder="Anything else?" />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="sg-check"
            checked={checked}
            onCheckedChange={(v) => setChecked(v === true)}
          />
          <Label htmlFor="sg-check">Accept terms</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="sg-switch" defaultChecked />
          <Label htmlFor="sg-switch">Email notifications</Label>
        </div>
      </div>
    </Section>
  );
}

function ProfileForm() {
  const form = useForm<Profile>({
    resolver: zodResolver(profileSchema),
    defaultValues: { username: "", email: "", bio: "", notify: true },
  });
  return (
    <Section
      title="Form"
      description="react-hook-form + zod (the same zod the API uses). Labels, descriptions and messages are wired to the control with ids and aria-describedby."
    >
      <Form {...form}>
        <form
          noValidate
          onSubmit={form.handleSubmit((v) =>
            toast.success(`Saved ${v.username}`),
          )}
          className="grid max-w-xl gap-4"
        >
          <FormField
            control={form.control}
            name="username"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Username</FormLabel>
                <FormControl>
                  <Input placeholder="ada" {...field} />
                </FormControl>
                <FormDescription>Your public display name.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    placeholder="ada@example.com"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Role</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="owner">Owner</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="member">Member</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="bio"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Bio</FormLabel>
                <FormControl>
                  <Textarea rows={3} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="notify"
            render={({ field }) => (
              <FormItem className="flex items-center gap-3">
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <FormLabel>Send me product updates</FormLabel>
              </FormItem>
            )}
          />
          <div className="flex gap-2">
            <Button type="submit">Save profile</Button>
            <Button type="button" variant="ghost" onClick={() => form.reset()}>
              Reset
            </Button>
          </div>
        </form>
      </Form>
    </Section>
  );
}

function Overlays() {
  return (
    <Section
      title="Overlays"
      description="Dialog, confirm (alert dialog), sheet, popover, tooltip. All trap or manage focus, close on Escape and return focus to the trigger."
    >
      <Row>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Open dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit workspace</DialogTitle>
              <DialogDescription>
                Changes apply to everyone in the workspace.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="sg-ws">Name</Label>
              <Input id="sg-ws" defaultValue="Acme" />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button>Save</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          trigger={<Button variant="destructive">Delete…</Button>}
          title="Delete this invoice?"
          description="This cannot be undone."
          confirmLabel="Delete"
          destructive
          onConfirm={() => toast.success("Deleted")}
        />

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline">Raw alert dialog</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you sure?</AlertDialogTitle>
              <AlertDialogDescription>
                Use ConfirmDialog unless you need a custom body.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>Continue</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline">Open sheet</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
              <SheetDescription>
                Side panel for secondary tasks.
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-2 px-4">
              <Label htmlFor="sg-q">Search</Label>
              <Input id="sg-q" placeholder="Customer…" />
            </div>
            <SheetFooter>
              <SheetClose asChild>
                <Button>Apply</Button>
              </SheetClose>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">Popover</Button>
          </PopoverTrigger>
          <PopoverContent className="space-y-2">
            <p className="text-sm font-medium">Dimensions</p>
            <p className="text-sm text-muted-foreground">
              Non-modal content anchored to a trigger.
            </p>
          </PopoverContent>
        </Popover>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Settings">
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </Row>
    </Section>
  );
}

function Menus() {
  const [bold, setBold] = useState(true);
  const [italic, setItalic] = useState(false);
  return (
    <Section
      title="Menus"
      description="Arrow keys move, Enter selects, Escape closes, typing jumps to an item."
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            Options <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52">
          <DropdownMenuLabel>Text</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={bold} onCheckedChange={setBold}>
            <Bold /> Bold
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={italic}
            onCheckedChange={setItalic}
          >
            <Italic /> Italic
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => toast("Duplicated")}>
            Duplicate <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Section>
  );
}

function TabsCards() {
  return (
    <Section title="Tabs & cards">
      <Tabs defaultValue="overview" className="max-w-xl">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle>Revenue</CardTitle>
              <CardDescription>Last 30 days</CardDescription>
              <CardAction>
                <Badge variant="secondary">+12%</Badge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tabular-nums">
                {fmt.money(1_382_050)}
              </p>
            </CardContent>
            <CardFooter className="text-sm text-muted-foreground">
              Updated {fmt.elapsed("2026-03-07T11:48:00Z", NOW)}
            </CardFooter>
          </Card>
        </TabsContent>
        <TabsContent value="activity">
          <EmptyState title="No activity yet" />
        </TabsContent>
        <TabsContent value="settings">
          <p className="text-sm text-muted-foreground">Settings content.</p>
        </TabsContent>
      </Tabs>
    </Section>
  );
}

function Tables() {
  return (
    <Section
      title="Tables"
      description="DataTable: click a header to sort (asc → desc → off). The plain Table primitives are underneath for custom layouts."
    >
      <DataTable
        caption="Invoices"
        columns={invoiceColumns}
        rows={INVOICES}
        rowKey={(r) => r.id}
        initialSort={{ key: "due", dir: "asc" }}
      />
      <Table>
        <TableCaption>Plain table primitives.</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Plan</TableHead>
            <TableHead className="text-right">Seats</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Starter</TableCell>
            <TableCell className="text-right tabular-nums">5</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Team</TableCell>
            <TableCell className="text-right tabular-nums">25</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </Section>
  );
}

function States() {
  return (
    <Section
      title="States"
      description="Every query-backed panel renders exactly one of: loading, error, empty, data."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent>
            <LoadingState />
          </CardContent>
        </Card>
        <ErrorState
          error={new Error("The server did not respond.")}
          retry={() => toast("Retrying…")}
        />
        <EmptyState
          title="No invoices"
          description="Invoices you create will appear here."
          action={
            <Button size="sm">
              <Plus /> New invoice
            </Button>
          }
        />
        <div className="space-y-2 rounded-md border p-4">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </Section>
  );
}

function Files() {
  return (
    <Section
      title="Files"
      description="FileDrop hands you a File; uploadFile() from @/lib/upload stores it via /api/media/upload (signed-in only)."
    >
      <FileDrop
        className="max-w-md"
        accept="image/*,.pdf"
        description="PNG, JPG or PDF up to 10 MB."
        onFile={(f) => toast(`Picked ${f.name}`)}
      />
    </Section>
  );
}

function Toasts() {
  return (
    <Section
      title="Toasts"
      description="sonner. Call toast() from anywhere on the client; mount <Toaster /> once per page tree that toasts (the /app layout does; so does this page)."
    >
      <Row>
        <Button variant="outline" onClick={() => toast("Event created")}>
          Default
        </Button>
        <Button variant="outline" onClick={() => toast.success("Saved")}>
          Success
        </Button>
        <Button variant="outline" onClick={() => toast.error("Could not save")}>
          Error
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast("Item archived", {
              action: { label: "Undo", onClick: () => toast("Restored") },
            })
          }
        >
          With action
        </Button>
      </Row>
    </Section>
  );
}

function SidebarDemo() {
  return (
    <Section
      title="Sidebar"
      description="The app shell (components/app-shell.tsx) uses this inside /app: collapsible to icons on desktop, an off-canvas sheet on phones, Ctrl/⌘+B toggles. Shown here in its static form."
    >
      <SidebarProvider className="min-h-0 w-fit rounded-lg border">
        <Sidebar collapsible="none" className="rounded-lg">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive>
                      <Home /> <span>Dashboard</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>
                      <Inbox /> <span>Inbox</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>
                      <Settings /> <span>Settings</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>
    </Section>
  );
}

function Formatting() {
  return (
    <Section
      title="Formatting"
      description={
        <>
          lib/format.ts — locale, currency and timezone come from APP_LOCALE /
          APP_CURRENCY / APP_TIMEZONE; use{" "}
          <code className="font-mono">useFormat()</code> in client components
          and <code className="font-mono">getFormatter()</code> on the server.
          Same inputs, four configs:
        </>
      }
    >
      <Table>
        <TableCaption className="sr-only">Formatting examples</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Config</TableHead>
            <TableHead className="text-right">money(125050)</TableHead>
            <TableHead>date(…T04:30Z, datetime)</TableHead>
            <TableHead>relative(+1 day)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(FORMATTERS).map(([name, f]) => (
            <TableRow key={name}>
              <TableCell className="font-medium">{name}</TableCell>
              <TableCell className="text-right tabular-nums">
                {f.money(125_050)}
              </TableCell>
              <TableCell>
                {f.date("2026-03-08T04:30:00Z", "datetime")}
              </TableCell>
              <TableCell>{f.relative("2026-03-08", NOW)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}
