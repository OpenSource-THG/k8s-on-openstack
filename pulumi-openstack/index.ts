import * as k8s from "@pulumi/kubernetes";
import * as kx from "@pulumi/kubernetesx";
import * as os from "@pulumi/openstack";
import * as pulumi from "@pulumi/pulumi";
import { cidrhost } from "@sophosoft/hard-cidr";
import { readFileSync } from 'fs';
import * as _ from "lodash";

// hardcode bastion floating ip
const bastion_floating_ip = "216.119.153.178";

const whitelisted_networks : Record<string,string> = {
    "Your_Location": "<your cidr>",
  };

// move most of these to Pulumi.rnd.yaml
const controller_count = 3;
const controller_flavor = "n1.medium";
const worker_count = 2;
const worker_flavor = "n1.medium";
const cidr = "10.66.0.0/16";
const k8s_network_cidr = "10.66.1.0/24";
const pip_version = "19.3.1";
const dependencies = JSON.stringify({"awscli": "1.16.290", "ansible": "2.9.2", "six": "1.13.0", "decorator": "4.4.1", "openstacksdk": "0.43.0"});
const env = "";
const project_config = new pulumi.Config();
const openstack_config = new pulumi.Config("openstack");
console.log(`Version: ${project_config.require("infra_version")}`);
const infra_version = project_config.require("infra_version");
const auth_url = openstack_config.get("authUrl");
const project_id = project_config.require("project_id");
const region = project_config.require("region");
const user_domain_name = project_config.require("user_domain_name");

// required to be able to await for data
export = async () => {
    const os_service_account_user = await os.keymanager.getSecret({
        name: "os_service_account_user",
        mode: "cbc"
    }).then(s => s.payload);
    const os_service_account_pass = await os.keymanager.getSecret({
        name: "os_service_account_pass",
        mode: "cbc"
    }).then(s => s.payload);
    const aws_access_key_id = await os.keymanager.getSecret({
        name: "aws_access_key_id",
        mode: "cbc"
    }).then(s => s.payload);
    const aws_secret_access_key = await os.keymanager.getSecret({
        name: "aws_secret_access_key",
        mode: "cbc"
    }).then(s => s.payload);


    const bastion_user_data_template = readFileSync('./cloud-config').toString();
    const vars_map = {
        os_service_account_user: os_service_account_user,
        os_service_account_pass: os_service_account_pass,
        aws_access_key_id: aws_access_key_id,
        aws_secret_access_key: aws_secret_access_key,
        auth_url: auth_url,
        project_id: project_id,
        region: region,
        user_domain_name: user_domain_name
    }
    const compiled_bastion_user_data =  _.template(bastion_user_data_template);
    const rendered_bastion_user_data = compiled_bastion_user_data(vars_map);

    const external_network = os.networking.getNetwork({
        name: "thg-external-1",
    });
    
    const availability_zones = os.compute.getAvailabilityZones();
    
    const centos_image = os.images.getImage({
        mostRecent: true,
        name: "CentOS 7 THG Base"
    });
    
    const k8s_network = new os.networking.Network("k8s_network", {
        adminStateUp: true,
    });
    
    const k8s_subnet = new os.networking.Subnet("k8s_subnet", {
        cidr: k8s_network_cidr,
        ipVersion: 4,
        networkId: k8s_network.id,
        allocationPools: [
            {
                start: "10.66.1.20",
                end: "10.66.1.254"
            } 
        ]
    }, {parent: k8s_network});
    
    const k8s_router = new os.networking.Router("k8s_router", {
        adminStateUp: true,
        externalNetworkId: external_network.then(external_network => external_network.id),
    });
    
    const router_ip = k8s_subnet.cidr.apply(c => cidrhost(c, 1).replace('/32',''));
    
    const k8s_router_port = new os.networking.Port("k8s_router_port", {
        networkId: k8s_network.id,
        fixedIps: [
            {
                subnetId: k8s_subnet.id,
                ipAddress: router_ip
            }
        ]
    });
    
    const k8s_router_if = new os.networking.RouterInterface("router_interface_router_to_k8s", {
        routerId: k8s_router.id,
        portId: k8s_router_port.id
    });
    
    // remote access

    const general_access_to_loadbalancer = new os.networking.SecGroup("general_access_to_loadbalancer", {
        name: "general_access_to_loadbalancer",
        description: "Internet access to dev loadbalancers from allowed networks",
    });

    new os.networking.SecGroupRule("insecure web access",  {
        securityGroupId: general_access_to_loadbalancer.id,
        description: `insecure web access`,
        portRangeMin: 80,
        portRangeMax: 80,
        protocol: "tcp",
        direction: "ingress",
        remoteIpPrefix: "0.0.0.0/0",
        ethertype: "IPv4"
    }, {parent: general_access_to_loadbalancer});

    for (const key in whitelisted_networks) {
        const element = whitelisted_networks[key];
        
        new os.networking.SecGroupRule(`secure web access ${key}`,  {
            securityGroupId: general_access_to_loadbalancer.id,
            description: `secure web access ${key}`,
            portRangeMin: 443,
            portRangeMax: 443,
            protocol: "tcp",
            direction: "ingress",
            remoteIpPrefix: element,
            ethertype: "IPv4"
        }, {parent: general_access_to_loadbalancer});

        new os.networking.SecGroupRule(`k8s secure web access ${key}`,  {
            securityGroupId: general_access_to_loadbalancer.id,
            description: `k8s secure web access ${key}`,
            portRangeMin: 6443,
            portRangeMax: 6443,
            protocol: "tcp",
            direction: "ingress",
            remoteIpPrefix: element,
            ethertype: "IPv4"
        }, {parent: general_access_to_loadbalancer});

    }

    const cockpit_access_to_loadbalancer = new os.networking.SecGroup("cockpit_access_to_loadbalancer", {
        name: "cockpit_access_to_loadbalancer",
        description: "Internet access to loadbalancers from cockpit-ed networks"
        //tags = [`cockpit_access_to_loadbalancer_${var.os_env}`, var.os_env, "cockpit", "web"]
    });

    const general_access_to_bastion = new os.networking.SecGroup("general_access_to_bastion", {
        name: "general_access_to_bastion",
        description: "SSH access to Bastion",
        tags: ["ssh"]
    });

    new os.networking.SecGroupRule(`ssh access`,  {
        securityGroupId: general_access_to_bastion.id,
        description: `ssh access`,
        portRangeMin: 22,
        portRangeMax: 22,
        protocol: "tcp",
        direction: "ingress",
        remoteIpPrefix: "0.0.0.0/0",
        ethertype: "IPv4"
    }, {parent: general_access_to_bastion});

    const internal_sec_group = new os.networking.SecGroup("internal_sec_group", {
        name: "internal_sec_group",
        description: "flat networking",
        tags: ["k8s-to-k8s"]
    });

    // allow all traffic via openstack firewalls as using micro-segmentation (host-based firewall rules)
    new os.networking.SecGroupRule("open flat network - ingress",  {
        securityGroupId: internal_sec_group.id,
        description: `open flat network`,
        protocol: "tcp",
        direction: "ingress",
        remoteIpPrefix: k8s_network_cidr,
        ethertype: "IPv4"
    }, {parent: internal_sec_group});

    new os.networking.SecGroupRule("open flat network - egress",  {
        securityGroupId: internal_sec_group.id,
        description: `open flat network`,
        protocol: "tcp",
        direction: "egress",
        remoteIpPrefix: k8s_network_cidr,
        ethertype: "IPv4"
    }, {parent: internal_sec_group});

    new os.networking.SecGroupRule("open flat network - IPIP support",  {
        securityGroupId: internal_sec_group.id,
        description: `open flat network`,
        protocol: "4",
        direction: "ingress",
        remoteIpPrefix: k8s_network_cidr,
        ethertype: "IPv4"
    }, {parent: internal_sec_group});

    for (let index = 0; index < controller_count; index++) {
        
        new os.compute.Instance(`k8s-controller-${index}`, {
            flavorName: controller_flavor,
            availabilityZone: availability_zones.then(availability_zones => availability_zones.names[0]),
            networks: [
                {
                    uuid: k8s_network.id
                }
            ],
            securityGroups: [
                internal_sec_group.id
            ],
            blockDevices: [
                {
                    sourceType: "image",
                    uuid: centos_image.then(centos_image => centos_image.id),
                    destinationType: "volume",
                    bootIndex: 0,
                    deleteOnTermination: true,
                    volumeSize: 20
                }
            ],
            metadata: {
                environment: "k8s-poc",
                component: "k8s-controller",
                class: "k8s-controller",
                playbook: "k8s-controller.yaml",
                pip: pip_version,
                dependencies: dependencies,
                env_vars_file: "example.yml",
                playbook_dir: "",
                infra_version: infra_version
            },
            userData: rendered_bastion_user_data
        }, {dependsOn: [k8s_subnet, internal_sec_group]});
        
    }

    for (let index = 0; index < worker_count; index++) {
        
        new os.compute.Instance(`k8s-worker-${index}`, {
            flavorName: worker_flavor,
            availabilityZone: availability_zones.then(availability_zones => availability_zones.names[0]),
            networks: [
                {
                    uuid: k8s_network.id
                }
            ],
            securityGroups: [
                internal_sec_group.id
            ],
            blockDevices: [
                {
                    sourceType: "image",
                    uuid: centos_image.then(centos_image => centos_image.id),
                    destinationType: "volume",
                    bootIndex: 0,
                    deleteOnTermination: true,
                    volumeSize: 50
                }
            ],
            metadata: {
                environment: "k8s-poc",
                component: "k8s-worker",
                class: "k8s-worker",
                playbook: "k8s-worker.yaml",
                pip: pip_version,
                dependencies: dependencies,
                env_vars_file: "example.yml",
                playbook_dir: "",
                infra_version: infra_version
            },
            userData: rendered_bastion_user_data
        }, {dependsOn: [k8s_subnet, internal_sec_group]});
        
    }

    const bastion_ip = k8s_subnet.cidr.apply(c => cidrhost(c, 19).replace('/32',''));
    
    const bastion_port = new os.networking.Port("bastion_port", {
        networkId: k8s_network.id,
        fixedIps: [
            {
                subnetId: k8s_subnet.id,
                ipAddress: bastion_ip
            }
        ],
        securityGroupIds: [
            general_access_to_bastion.id
        ],
    });

    const bastion = new os.compute.Instance("bastion", {
        flavorName: "c1.tiny",
        availabilityZone: availability_zones.then(availability_zones => availability_zones.names[0]),
        networks: [
            {
                port: bastion_port.id
            }
        ],
        blockDevices: [
            {
                sourceType: "image",
                uuid: centos_image.then(centos_image => centos_image.id),
                destinationType: "volume",
                bootIndex: 0,
                deleteOnTermination: true,
                volumeSize: 20
            }
        ],
        metadata: {
            environment: "k8s-poc",
            component: "bastion",
            class: "bastion",
            playbook: "bastion.yaml",
            pip: pip_version,
            dependencies: dependencies,
            env_vars_file: "example.yml",
            playbook_dir: "",
            infra_version: infra_version
        },
        userData: rendered_bastion_user_data
    }, {dependsOn: [k8s_subnet, general_access_to_bastion]});
    
    const assoc_bastion_ip = new os.networking.FloatingIpAssociate("associate_bastion_fip", {
        floatingIp: bastion_floating_ip,
        portId: bastion_port.id
    }, {parent: bastion});

}

// const appLabels = { app: "nginx" };
// const deployment = new k8s.apps.v1.Deployment("nginx", {
//     spec: {
//         selector: { matchLabels: appLabels },
//         replicas: 1,
//         template: {
//             metadata: { labels: appLabels },
//             spec: { containers: [{ name: "nginx", image: "nginx" }] }
//         }
//     }
// });
// export const name = deployment.metadata.name;
