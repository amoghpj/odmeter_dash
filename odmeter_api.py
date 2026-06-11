import requests
import typing
import pandas as pd
import json
import iso8601

class ODMeterSystem:
    def __init__(self, user: str, server_addr: str = "127.0.0.1:8080"):
        self._server_addr = server_addr
        self._config = self.config()

        user_list = [u["name"] for u in self._config["users"]]
        if user in user_list:
            self._user = user
        else:
            raise ValueError("user not found")

    def config(self):
        return requests.get("http://%s/api/config/" % self._server_addr).json()

    def standard_curves(self):
        config = self.config()
        standard_curves = []
        for resp in config['standard_curves']:
            standard_curves.append(StandardCurve(resp))
    
    def device_status(self):
        return requests.get("http://%s/api/device/" % self._server_addr).json()

    def samples(self):
        resp_list = requests.get("http://%s/api/sample/" % self._server_addr).json()
        samples = []
        for resp in resp_list:
            samples.append(Sample(resp["device"], resp["channel"], resp, self))
        return samples
    
    def experiments(self):
        resp_list = requests.get("http://%s/api/acqusition/" % self._server_addr).json()
        experiments = []
        for resp in resp_list:
            experiments.append(Experiment(resp["name"], resp, self))
        return experiments

    def create_samples(self,
                       device: typing.Union[str, list[str]],
                       ch: typing.Union[int, list[int]],
                       name: typing.Union[str, list[str]]="",
                       standard_curve_name: typing.Union[str, list[str]]="",
                       metadata: typing.Union[dict[str, str], list[dict[str, str]]]={}):
        req_list = []
        if isinstance(device, str):
            req_list.append({
                "device": device,
                "channel": ch,
                "name": name,
                "metadata": metadata,
                "standard_curve_name": standard_curve_name,
                "user": self._user,
            })
        elif isinstance(device, list):
            if not isinstance(ch, list):
                raise ValueError("ch is not a list")
            if (not isinstance(name, list)) and (name != ""):
                raise ValueError("ch is not a list")
            if (not isinstance(metadata, list)) and (metadata != {}):
                raise ValueError("ch is not a list")
            if (not isinstance(standard_curve_name, list)) and (standard_curve_name != ""):
                raise ValueError("ch is not a list")
            for i in range(len(device)):
                req = {
                    "device": device[i],
                    "channel": ch[i]
                }
                if name == "":
                    req["name"] = ""
                else:
                    req["name"] = name[i]

                if metadata == {}:
                    req["metadata"] = {}
                else:
                    req["metadata"] = metadata[i]

                if standard_curve_name == "":
                    req["standard_curve_name"] = ""
                else:
                    req["standard_curve_name"] = standard_curve_name[i]
                
                req_list.append(req)
        else:
            raise ValueError("device is expected to be str or list of str")

        resp = requests.post("http://%s/api/sample/" % self._server_addr, json=req_list)
        if resp.status_code != 200:
            raise RuntimeError("%d: %s" % (resp.status_code, resp.text))
    
    def remove_sample(self, samples):
        req_list = []
        if not isinstance(samples, list):
            samples = [samples]
        
        for sample in samples:
            req_list.append({
                    "device": sample.device,
                    "channel": sample.channel,
                })
        
        resp = requests.delete("http://%s/api/sample/" % self._server_addr, json=req_list)
        if resp.status_code != 200:
            raise RuntimeError("%d: %s" % (resp.status_code, resp.text))
        
    def create_experiment(self, name, samples, interval=30, description=''):
        req_sample_list = []
        for sample in samples:
            req_sample_list.append({"uuid": sample.uuid})

        resp = requests.post("http://%s/api/acqusition/" % self._server_addr, json={
            "name": name,
            "description": description,
            "interval": interval,
            "samples": req_sample_list,
            "user": self._user,
        })
        if resp.status_code != 200:
            raise RuntimeError("%d: %s" % (resp.status_code, resp.text))
    
class StandardCurve:
    def __init__(self, data):
        self._data = data

class Sample:
    def __init__(self, device, channel, data, system: ODMeterSystem):
        self._device = device
        self._channel = channel
        self._data = data
        self._system = system
    
    def __repr__(self):
        return "%s.%d" % (self.device, self.channel)

    @property
    def device(self):
        return self._device

    @property
    def channel(self):
        return self._channel
    
    @property
    def uuid(self):
        return self._data["uuid"]
    
    def data(self):
        resp = requests.get("http://%s/api/sample/%s.%d/data/"
                            % (self._system._server_addr, self.device, self.channel)).json()
        return pd.DataFrame(resp["readings"])

class Experiment:
    def __init__(self, name, data, system: ODMeterSystem):
        self._data = data
        self._system = system

    def __repr__(self):
        return self.name

    @property
    def name(self):
        return self._data["name"]

    def start(self):
        resp = requests.get("http://%s/api/acqusition/%s/start/"
                            % (self._system._server_addr, self.name))
        if resp.status_code != 200:
            raise RuntimeError("%d: %s" % (resp.status_code, resp.text))

    def stop(self):
        resp = requests.get("http://%s/api/acqusition/%s/stop/"
                            % (self._system._server_addr, self.name))
        if resp.status_code != 200:
            raise RuntimeError("%d: %s" % (resp.status_code, resp.text))

    def close(self):
        resp = requests.get("http://%s/api/acqusition/%s/close/"
                            % (self._system._server_addr, self.name))
        if resp.status_code != 200:
            raise RuntimeError("%d: %s" % (resp.status_code, resp.text))

    def data(self):
        resp_list = requests.get("http://%s/api/acqusition/%s/data/"
                            % (self._system._server_addr, self.name)).json()
        
        df_all = pd.DataFrame()
        for resp in resp_list:
            df = pd.DataFrame(resp["readings"])
            df.t = pd.to_datetime(df.t)
            df['sample_name'] = resp["info"]["name"]
            t_start = df.t[0]
            df['t_min'] = (df.t - t_start).dt.total_seconds() / 60

            df_all = pd.concat([df_all, df])

        return df_all

def load_data_file(exp_name):
    df = pd.read_csv("Data/%s.csv" % exp_name, comment="#")
    f=open("Data/%s.csv" % exp_name, "r")
    meta=json.loads(f.readline()[1:])
    f.close()
    
    df.device = df.device.apply(str)
    df.channel = df.channel.apply(int)
    
    df["sample_name"] = ""
    for sample_info in meta["sample_info"]:
        dev = sample_info["device"]
        ch = sample_info["channel"]
        name = sample_info["name"]
        df.loc[(df.device == dev) & (df.channel == ch), "sample_name"] = name
    
    for sample_name in df.sample_name.unique():
        dev_list = df[df.sample_name == sample_name].device.unique()
        if len(dev_list) > 1:
            for dev in dev_list:
                df.loc[(df.device==dev) & (df.sample_name==sample_name), "sample_name"] = "%s_%s" % (sample_name, dev)
    
    time_started = iso8601.parse_date(meta['time_started'])
    df['t_min'] = (pd.to_datetime(df.timestamp, format='ISO8601') - time_started).dt.total_seconds() / 60
    return df
