param(
  [string]$Namespace = "default"
)

$Root = Split-Path -Parent $PSScriptRoot

docker build -t igormendonca/gateway:latest -f (Join-Path $Root "Dockerfile.gateway") $Root
docker build -t igormendonca/worker:latest -f (Join-Path $Root "Dockerfile.worker") $Root
docker build -t igormendonca/matchmaker:latest -f (Join-Path $Root "Dockerfile.matchmaker") $Root

docker push igormendonca/gateway:latest
docker push igormendonca/worker:latest
docker push igormendonca/matchmaker:latest

kubectl apply -f (Join-Path $Root "k8s/redis.yaml") -n $Namespace
kubectl apply -f (Join-Path $Root "k8s/rbac.yaml") -n $Namespace
kubectl apply -f (Join-Path $Root "k8s/worker-deployment.yaml") -n $Namespace
kubectl apply -f (Join-Path $Root "k8s/matchmaker-deployment.yaml") -n $Namespace
kubectl apply -f (Join-Path $Root "k8s/gateway-deployment.yaml") -n $Namespace
kubectl apply -f (Join-Path $Root "k8s/redis-commander.yaml") -n $Namespace

kubectl rollout status deployment/redis -n $Namespace
kubectl rollout status deployment/worker -n $Namespace
kubectl rollout status deployment/matchmaker -n $Namespace
kubectl rollout status deployment/gateway -n $Namespace
kubectl rollout status deployment/redis-commander -n $Namespace

kubectl get pods -o wide -n $Namespace
kubectl get svc -n $Namespace
