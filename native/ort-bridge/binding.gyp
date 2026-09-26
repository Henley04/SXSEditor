{
  "targets": [
    {
      "target_name": "ort_bridge",
      "sources": [
        "bridge.cc"
      ],
      "include_dirs": ["include", "deps"],
      "defines": ["WIN32_LEAN_AND_MEAN", "NOMINMAX"],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCLinkerTool": {
              "DelayLoadDLLs": ["node.exe"],
              "AdditionalOptions": ["/IGNORE:4199"]
            }
          }
        }]
      ]
    }
  ]
}
