# Deployment policy for the Terraform code, checked by Conftest in CI on every
# pull request (SPEC: policy as code). A violation fails the build, so a
# non-compliant change can't reach main or be applied from it.
#
# Input: one .tf file parsed with `conftest --parser hcl2`. Blocks may come
# as an object or a list of objects, so every lookup goes through as_list.
package main

import rego.v1

as_list(x) := x if is_array(x)

as_list(x) := [x] if is_object(x)

resources(type) := [r |
	some name
	some r in as_list(input.resource[type][name])
]

# --- No public data stores. ---

deny contains msg if {
	some db in resources("aws_db_instance")
	db.publicly_accessible == true
	msg := "aws_db_instance must not be publicly accessible"
}

deny contains msg if {
	some db in resources("aws_db_instance")
	not db.storage_encrypted == true
	msg := "aws_db_instance must set storage_encrypted = true"
}

deny contains msg if {
	some db in resources("aws_db_instance")
	not db.iam_database_authentication_enabled == true
	msg := "aws_db_instance must use IAM database authentication"
}

# --- Private endpoints: nothing accepts traffic from a CIDR range. ---

deny contains msg if {
	some rule in resources("aws_vpc_security_group_ingress_rule")
	some field in ["cidr_ipv4", "cidr_ipv6"]
	rule[field]
	msg := sprintf("security group ingress must not use %s; allow a security group or prefix list", [field])
}

deny contains msg if {
	some rule in resources("aws_security_group_rule")
	rule.type == "ingress"
	count(object.get(rule, "cidr_blocks", [])) > 0
	msg := "security group ingress must not use cidr_blocks"
}

deny contains msg if {
	some group in resources("aws_security_group")
	some ingress in as_list(object.get(group, "ingress", []))
	count(object.get(ingress, "cidr_blocks", [])) > 0
	msg := "security group ingress must not use cidr_blocks"
}

# --- Signed images stay what was signed. ---

deny contains msg if {
	some repo in resources("aws_ecr_repository")
	not repo.image_tag_mutability == "IMMUTABLE"
	msg := "aws_ecr_repository must use IMMUTABLE tags"
}

# --- Tags present: the AWS provider tags every resource. ---

required_tags := {"project", "environment", "managed-by"}

deny contains msg if {
	some provider in as_list(input.provider.aws)
	tags := {key | some block in as_list(object.get(provider, "default_tags", [])); some key, _ in block.tags}
	missing := required_tags - tags
	count(missing) > 0
	msg := sprintf("the aws provider's default_tags must include %v", [sort(missing)])
}
