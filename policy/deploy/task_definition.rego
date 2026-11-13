# Deploy-time policy: the deploy workflow renders each ECS task definition
# with the new image and runs Conftest on it BEFORE registering it. Any
# violation stops the deploy (SPEC: non-compliant deployment is rejected).
package main

import rego.v1

# Our ECR repository, by immutable digest: never a tag, never another registry.
image_pattern := `^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/incident-tracker-[a-z]+@sha256:[0-9a-f]{64}$`

# Names that must come from `secrets` (SSM / Secrets Manager), never plain environment.
secret_name_pattern := `(?i)(PASSWORD|SECRET|TOKEN|PRIVATE|CREDENTIAL|ACCESS_KEY)`

deny contains msg if {
	count(object.get(input, "containerDefinitions", [])) == 0
	msg := "task definition has no containers"
}

deny contains msg if {
	some c in input.containerDefinitions
	not regex.match(image_pattern, c.image)
	msg := sprintf("container %q: image must be this project's ECR repository pinned by digest, got %q", [c.name, c.image])
}

deny contains msg if {
	some c in input.containerDefinitions
	not c.readonlyRootFilesystem == true
	msg := sprintf("container %q: readonlyRootFilesystem must be true", [c.name])
}

deny contains msg if {
	some c in input.containerDefinitions
	c.privileged == true
	msg := sprintf("container %q: privileged containers are not allowed", [c.name])
}

deny contains msg if {
	some c in input.containerDefinitions
	some env in object.get(c, "environment", [])
	regex.match(secret_name_pattern, env.name)
	msg := sprintf("container %q: %s looks like a secret; pass it through secrets, not environment", [c.name, env.name])
}

deny contains msg if {
	not input.networkMode == "awsvpc"
	msg := "networkMode must be awsvpc"
}
