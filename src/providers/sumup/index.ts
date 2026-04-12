import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import { SumUpProviderService } from "./services";

const services = [SumUpProviderService];

export default ModuleProvider(Modules.PAYMENT, {
  services,
});
