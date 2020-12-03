import * as pulumi from "@pulumi/pulumi";
import * as os from "@pulumi/openstack";

const bastion_ip = new os.networking.FloatingIp("test_floating_ip", {
    pool: "thg-external-1",
});
