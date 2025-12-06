param(
  [string]$Namespace = "default"
)

kubectl delete -f k8s/gateway-deployment.yaml -n $Namespace --ignore-not-found=true
kubectl delete -f k8s/worker-deployment.yaml -n $Namespace --ignore-not-found=true
kubectl delete -f k8s/matchmaker-deployment.yaml -n $Namespace --ignore-not-found=true
kubectl delete -f k8s/redis.yaml -n $Namespace --ignore-not-found=true
kubectl delete -f k8s/rbac.yaml -n $Namespace --ignore-not-found=true
kubectl delete -f k8s/redis-commander.yaml -n $Namespace --ignore-not-found=true

# Delete dynamic region workers (e.g., deployments named worker-region-*)
$deploys = kubectl get deploy -n $Namespace -o name
$regionWorkers = $deploys | Select-String -Pattern '^deployment\.apps/worker-region-'
foreach ($d in $regionWorkers) {
  kubectl delete $d -n $Namespace --ignore-not-found=true
}

kubectl get pods -n $Namespace
kubectl get svc -n $Namespace

kubectl get pods -n $Namespace
kubectl get svc -n $Namespace
