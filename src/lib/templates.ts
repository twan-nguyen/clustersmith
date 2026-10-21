import { type ResourceKind, apiVersion } from "@/lib/kube";

/** Starting points for common kinds; the placeholders are meant to be edited. */
const TEMPLATES: Record<string, (ns: string) => string> = {
  deployments: (ns) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: ${ns}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:1.27
          ports:
            - containerPort: 80
`,
  services: (ns) => `apiVersion: v1
kind: Service
metadata:
  name: my-app
  namespace: ${ns}
spec:
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 80
`,
  configmaps: (ns) => `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: ${ns}
data:
  key: value
`,
  secrets: (ns) => `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  namespace: ${ns}
type: Opaque
stringData:
  key: value
`,
  jobs: (ns) => `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
  namespace: ${ns}
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:1.36
          command: ["sh", "-c", "echo done"]
`,
  cronjobs: (ns) => `apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-cron
  namespace: ${ns}
spec:
  schedule: "0 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: job
              image: busybox:1.36
              command: ["sh", "-c", "date"]
`,
  ingresses: (ns) => `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: ${ns}
spec:
  rules:
    - host: my-app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  number: 80
`,
  persistentvolumeclaims: (ns) => `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-data
  namespace: ${ns}
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
`,
  namespaces: () => `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
`,
};

/** YAML to start a new object of `kind` from, in `namespace` when it has one. */
export function templateFor(kind: ResourceKind | undefined, namespace: string | null) {
  const ns = namespace ?? "default";
  const known = kind && TEMPLATES[kind.id];
  if (known) return known(ns);
  if (!kind) return TEMPLATES.deployments(ns);
  const scope = kind.namespaced ? `\n  namespace: ${ns}` : "";
  return `apiVersion: ${apiVersion(kind)}
kind: ${kind.singular}
metadata:
  name: my-${kind.singular.toLowerCase()}${scope}
spec: {}
`;
}
